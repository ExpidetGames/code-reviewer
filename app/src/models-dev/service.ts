// SPDX-License-Identifier: Apache-2.0

// The daily fetch of the models.dev catalog (#548), end to end: fetch the body, parse it, judge the providers' addresses,
// plan what to write, check the guard and apply the plan in one transaction. A fetch that fails, does not parse or would
// unlist an implausibly large share of the catalog changes nothing: the previous rows stay, the failure is recorded as a
// stable code (`last_error` of the fetch state) and logged, and nothing is ever deleted. Two runs never overlap (a
// database try-lock; the second answers `already_running` at once). Counts and codes are logged, never a name or an
// address from the body.
//
// The clock is the caller's: the sweep (src/dispatch/sweep.ts) and the timer of a long-lived server
// (src/models-dev/startup.ts) both call `refreshIfDue`; an admin's "fetch now" (#554) calls `refresh`.
import "server-only";
import type { Kysely } from "kysely";
import { createModelsDevRepository, type ModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import type { Database } from "../db/schema.ts";
import { MODELS_DEV_LOCK, tryWithLock } from "../db/try-lock.ts";
import type { FetchSummary } from "./catalog.ts";
import type { ModelsDevFetchErrorCode } from "./errors.ts";
import { fetchModelsDev, type FetchLike } from "./fetch.ts";
import { supportedProvider } from "./opencode-providers.ts";
import { parseModelsDev, type ReducedProvider } from "./parse.ts";
import { planCatalog } from "./plan.ts";
import {
  loadModelsDevSettings,
  type ModelsDevSettings,
} from "./settings.ts";
import { checkUpstreamUrl, dnsResolver, type HostResolver, type UrlCheck } from "./upstream-url.ts";

const HOUR_MS = 60 * 60 * 1000;
/** A successful fetch is due again after this long: a tick every two hours then comes about once a day. */
export const FETCH_INTERVAL_MS = 23 * HOUR_MS;
/** After a failure the next try waits this long. */
export const RETRY_AFTER_FAILURE_MS = HOUR_MS;
/** Addresses looked up at the same time. */
const LOOKUP_CONCURRENCY = 8;

export type RefreshOutcome =
  | { status: "skipped"; reason: "fetch_off" | "not_due" | "already_running" }
  | { status: "applied"; summary: FetchSummary }
  | { status: "failed"; code: ModelsDevFetchErrorCode };

export type RefreshOptions = {
  /** Apply a fetch the guard refused: an admin who has looked at what would be unlisted (#554). */
  acceptLargeRemoval?: boolean;
};

export type ModelsDevService = {
  /** Fetches now, whether or not a fetch is due (a fetch that is switched off is still skipped). */
  refresh(options?: RefreshOptions): Promise<RefreshOutcome>;
  /** Fetches when the last success is older than a day and the last failure older than an hour. */
  refreshIfDue(): Promise<RefreshOutcome>;
};

export type ModelsDevServiceDependencies = {
  db: Kysely<Database>;
  repository?: ModelsDevRepository;
  /** Read on every run, so the operator can change them without a restart. */
  settings?: () => ModelsDevSettings;
  fetchImpl?: FetchLike;
  resolveHost?: HostResolver;
  now?: () => Date;
  log?: Pick<Console, "info" | "error">;
  timeoutMs?: number;
  maxBytes?: number;
};

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++)
      results[index] = await work(items[index] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createModelsDevService(deps: ModelsDevServiceDependencies): ModelsDevService {
  const repository = deps.repository ?? createModelsDevRepository(deps.db);
  const settings = deps.settings ?? (() => loadModelsDevSettings(process.env));
  const resolveHost = deps.resolveHost ?? dnsResolver;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;

  async function urlChecksOf(providers: readonly ReducedProvider[]) {
    const checked = await mapLimited(providers, LOOKUP_CONCURRENCY, async (provider) => {
      // The address models.dev states, else the default of the provider's SDK that the supported file records.
      const candidate = provider.api ?? supportedProvider(provider.id)?.defaultBaseUrl ?? null;
      const check: UrlCheck = provider.apiTooLong
        ? { ok: false, problem: "too_long", seen: candidate }
        : await checkUpstreamUrl(candidate, resolveHost);
      return [provider.id, check] as const;
    });
    return new Map(checked);
  }

  async function fail(code: ModelsDevFetchErrorCode, detail = ""): Promise<RefreshOutcome> {
    try {
      await repository.recordFailure(code, now());
    } catch {
      log.error("[models-dev] MODELS_DEV_STATE_NOT_RECORDED: the failure could not be written.");
    }
    log.error(`[models-dev] MODELS_DEV_FETCH_FAILED code=${code}${detail === "" ? "" : ` ${detail}`}; the catalog is unchanged.`);
    return { status: "failed", code };
  }

  async function work(options: RefreshOptions): Promise<RefreshOutcome> {
    const fetched = await fetchModelsDev({
      url: settings().url,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
    });
    if (!fetched.ok) return fail(fetched.code);
    const parsed = parseModelsDev(fetched.body);
    if (!parsed.ok) return fail(parsed.code);
    const stored = {
      providers: await repository.listProviders(),
      models: await repository.listModels(),
    };
    const plan = planCatalog({
      parsed,
      stored,
      urlChecks: await urlChecksOf(parsed.providers),
      now: now(),
    });
    if (plan.guard.tripped && options.acceptLargeRemoval !== true)
      return fail(
        "models_dev_guard_unlisted_share",
        `unlisted=${String(plan.guard.unlisted)} listed=${String(plan.guard.listed)}`,
      );
    await repository.apply(plan.write, { summary: plan.summary, at: now() });
    const s = plan.summary;
    log.info(
      `[models-dev] fetched: providers=${String(s.providers)} models=${String(s.models)} new=${String(s.newModels)} changed=${String(s.changedModels)} unlisted=${String(s.unlistedModels)} returned=${String(s.returnedModels)} blocked_providers=${String(s.blockedProviders)} rejected_providers=${String(s.rejectedProviders)}.`,
    );
    return { status: "applied", summary: plan.summary };
  }

  async function run(options: RefreshOptions, onlyIfDue: boolean): Promise<RefreshOutcome> {
    if (!settings().enabled) return { status: "skipped", reason: "fetch_off" };
    try {
      const locked = await tryWithLock(deps.db, MODELS_DEV_LOCK, async (): Promise<RefreshOutcome> => {
        // Looked at again under the lock: another instance may have fetched while this one waited for its turn.
        if (onlyIfDue && !(await isDue())) return { status: "skipped", reason: "not_due" };
        return work(options);
      });
      return locked.acquired ? locked.value : { status: "skipped", reason: "already_running" };
    } catch {
      return fail("models_dev_internal");
    }
  }

  async function isDue(): Promise<boolean> {
    const state = await repository.fetchState();
    if (state === undefined || state.lastSuccessAt === null) {
      // Never succeeded: a failure is retried after an hour, a first run is due at once.
      return state?.lastAttemptAt == null || now().getTime() - Date.parse(state.lastAttemptAt) >= RETRY_AFTER_FAILURE_MS;
    }
    const current = now().getTime();
    if (current - Date.parse(state.lastSuccessAt) < FETCH_INTERVAL_MS) return false;
    return state.lastAttemptAt === null || current - Date.parse(state.lastAttemptAt) >= RETRY_AFTER_FAILURE_MS;
  }

  return {
    refresh: (options = {}) => run(options, false),
    refreshIfDue: () => run({}, true),
  };
}
