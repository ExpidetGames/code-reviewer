// SPDX-License-Identifier: LicenseRef-Proprietary

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
import { createModelEnablementsRepository } from "../db/repositories/model-enablements-repository.ts";
import {
  createModelsDevRepository,
  type ModelsDevRepository,
} from "../db/repositories/models-dev-repository.ts";
import type { Database } from "../db/schema.ts";
import { MODELS_DEV_LOCK, tryWithLock } from "../db/try-lock.ts";
import type { FetchSummary } from "./catalog.ts";
import {
  GUARD_ERROR_CODES,
  type GuardFigures,
  type GuardReason,
  ModelsDevDeadlineError,
  type ModelsDevFetchErrorCode,
} from "./errors.ts";
import { fetchModelsDev, FETCH_TIMEOUT_MS, type FetchLike } from "./fetch.ts";
import { supportedProvider } from "./opencode-providers.ts";
import {
  parseModelsDev,
  type ParsedModelsDev,
  type ReducedProvider,
} from "./parse.ts";
import { guardFigures, planCatalog, type Guard } from "./plan.ts";
import { loadModelsDevSettings, type ModelsDevSettings } from "./settings.ts";
import {
  checkUpstreamUrl,
  dnsResolver,
  type HostResolver,
  type UrlCheck,
} from "./upstream-url.ts";

const HOUR_MS = 60 * 60 * 1000;
/** A successful fetch is due again after this long: a tick every two hours then comes about once a day. */
export const FETCH_INTERVAL_MS = 23 * HOUR_MS;
/** After a failure the next try waits this long. */
export const RETRY_AFTER_FAILURE_MS = HOUR_MS;
/** Addresses looked up at the same time. */
const LOOKUP_CONCURRENCY = 8;
/**
 * The whole run, from the first byte requested to the last row written: one deadline for the fetch, the lookups and the
 * write. The sweep of a hosted deployment runs in a function of 300 seconds and passes its own budget (`sweep.ts`); this
 * is the default of every other caller (the timer of a long-lived server).
 */
export const DEFAULT_DEADLINE_MS = 90_000;
/** What the lookups leave of the deadline for the write: 6,500 rows in batches of 100 take a few seconds at most. */
export const WRITE_RESERVE_MS = 10_000;

/** Why the guard stopped a fetch: every reason that tripped (fixed order) and what it measured. */
export type GuardStop = { reasons: GuardReason[]; figures: GuardFigures };

export type RefreshOutcome =
  | { status: "skipped"; reason: "fetch_off" | "not_due" | "already_running" }
  | { status: "applied"; summary: FetchSummary }
  /** `guard` is there when the guard stopped the fetch: `code` is the first reason that was not accepted. */
  | { status: "failed"; code: ModelsDevFetchErrorCode; guard?: GuardStop };

export type RefreshOptions = {
  /** The time the whole run may take (fetch, lookups and write together); `DEFAULT_DEADLINE_MS` when left out. */
  deadlineMs?: number;
  /**
   * The guard reasons an admin who looked at them accepts (#554). A fetch is applied only when every reason that trips is
   * in this list; one that is not, or a reason that is new, refuses it again with the full list of what tripped.
   */
  acceptReasons?: readonly GuardReason[];
};

export type ModelsDevService = {
  /** Fetches now, whether or not a fetch is due (a fetch that is switched off is still skipped). */
  refresh(options?: RefreshOptions): Promise<RefreshOutcome>;
  /**
   * Fetches when the last success is older than a day and the last failure older than an hour (and, while a new provider's
   * name has not resolved yet, an hour after the last attempt).
   */
  refreshIfDue(options?: { deadlineMs?: number }): Promise<RefreshOutcome>;
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
  /** The default deadline of a run; a run can ask for another. */
  deadlineMs?: number;
  /** What the lookups leave of the deadline for the write. */
  writeReserveMs?: number;
  lookupConcurrency?: number;
  /** Milliseconds, for the deadline only (the dates that are stored come from `now`). */
  clock?: () => number;
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export function createModelsDevService(
  deps: ModelsDevServiceDependencies,
): ModelsDevService {
  const repository = deps.repository ?? createModelsDevRepository(deps.db);
  const settings = deps.settings ?? (() => loadModelsDevSettings(process.env));
  const resolveHost = deps.resolveHost ?? dnsResolver;
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.log ?? console;

  /**
   * The verdict on every provider's address. A lookup that is still running when `until` comes, and every lookup that
   * would begin after it, ends as "the name did not resolve", which says nothing about the address (`nextUrlState`): a
   * trusted address stays as it is, a new provider waits for the next sweep. The number of lookups cut short is returned.
   */
  async function urlChecksOf(
    providers: readonly ReducedProvider[],
    until: number,
  ) {
    let cut = 0;
    const checked = await mapLimited(
      providers,
      deps.lookupConcurrency ?? LOOKUP_CONCURRENCY,
      async (provider) => {
        let cutShort = false;
        const resolver: HostResolver = async (hostname) => {
          const left = until - clock();
          if (left <= 0) {
            cutShort = true;
            throw new Error("deadline");
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              resolveHost(hostname),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  cutShort = true;
                  reject(new Error("deadline"));
                }, left);
                timer.unref();
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        // The address models.dev states, else the default of the provider's SDK that the supported file records.
        const candidate =
          provider.api ??
          supportedProvider(provider.id)?.defaultBaseUrl ??
          null;
        const check: UrlCheck = provider.apiTooLong
          ? { ok: false, problem: "too_long", seen: candidate }
          : await checkUpstreamUrl(candidate, resolver);
        if (cutShort) cut += 1;
        return [provider.id, check] as const;
      },
    );
    return { checks: new Map(checked), cut };
  }

  async function fail(
    code: ModelsDevFetchErrorCode,
    detail = "",
    guard?: GuardStop,
  ): Promise<RefreshOutcome> {
    try {
      await repository.recordFailure(code, now());
    } catch {
      log.error(
        "[models-dev] MODELS_DEV_STATE_NOT_RECORDED: the failure could not be written.",
      );
    }
    log.error(
      `[models-dev] MODELS_DEV_FETCH_FAILED code=${code}${detail === "" ? "" : ` ${detail}`}; the catalog is unchanged.`,
    );
    return guard === undefined
      ? { status: "failed", code }
      : { status: "failed", code, guard };
  }

  /** The first reason that tripped and was not accepted: the fetch is refused for it. `undefined` when it may be applied. */
  function notAccepted(guard: Guard, options: RefreshOptions) {
    return guard.reasons.find(
      (reason) => !(options.acceptReasons ?? []).includes(reason),
    );
  }

  async function work(options: RefreshOptions): Promise<RefreshOutcome> {
    const deadline =
      clock() + (options.deadlineMs ?? deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const remaining = () => deadline - clock();
    const fetched = await fetchModelsDev({
      url: settings().url,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      // The fetch may take what is left of the run, and never longer than its own limit.
      timeoutMs: Math.max(
        1,
        Math.min(deps.timeoutMs ?? FETCH_TIMEOUT_MS, remaining()),
      ),
      ...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
    });
    if (!fetched.ok) return fail(fetched.code);
    const parsed = parseModelsDev(fetched.body);
    if (!parsed.ok) return fail(parsed.code);
    // The addresses are judged before the transaction: a lookup can be slow and must not hold a database transaction open.
    const { checks: urlChecks, cut } = await urlChecksOf(
      parsed.providers,
      deadline - (deps.writeReserveMs ?? WRITE_RESERVE_MS),
    );
    if (remaining() <= 0) return fail("models_dev_timeout");
    // What is stored is read, planned against and written in one transaction. A transaction alone does not keep a change
    // made to a provider in between (an admin's confirmation, #554) from being written over: on Postgres (read committed)
    // the plan would be made on rows that have changed since. So the provider rows are read `FOR UPDATE`: a confirmation
    // made meanwhile waits for this transaction and is applied after it (its guard, `pending_url = ?`, is judged on what
    // this fetch wrote), one made before is seen by the plan. SQLite serialises writers by `begin immediate`.
    let planned: Awaited<ReturnType<typeof applyPlan>>;
    try {
      planned = await applyPlan(parsed, urlChecks, cut, options, remaining);
    } catch (error) {
      if (error instanceof ModelsDevDeadlineError) return fail(error.code);
      throw error;
    }
    const refusedFor = notAccepted(planned.guard, options);
    if (refusedFor !== undefined) {
      const { reasons } = planned.guard;
      const figures = guardFigures(planned.guard);
      return fail(
        GUARD_ERROR_CODES[refusedFor],
        `reasons=${reasons.join(",")} unlisted=${String(figures.unlisted)} listed=${String(figures.listed)}`,
        { reasons, figures },
      );
    }
    const s = planned.summary;
    log.info(
      `[models-dev] fetched: providers=${String(s.providers)} models=${String(s.models)} new=${String(s.newModels)} changed=${String(s.changedModels)} unlisted=${String(s.unlistedModels)} returned=${String(s.returnedModels)} blocked_providers=${String(s.blockedProviders)} rejected_providers=${String(s.rejectedProviders)} lookups_cut=${String(cut)}.`,
    );
    return { status: "applied", summary: planned.summary };
  }

  async function applyPlan(
    parsed: ParsedModelsDev,
    urlChecks: ReadonlyMap<string, UrlCheck>,
    lookupsSkipped: number,
    options: RefreshOptions,
    remaining: () => number,
  ) {
    return deps.db.transaction().execute(async (trx) => {
      const transactional = createModelsDevRepository(trx);
      const plan = planCatalog({
        parsed,
        stored: {
          providers: await transactional.listProviders({ forUpdate: true }),
          models: await transactional.listModels(),
        },
        urlChecks,
        now: now(),
        // The models an admin enabled come first in the guard (#549).
        enabled: await createModelEnablementsRepository(trx).listEnabled(),
      });
      const summary: FetchSummary = { ...plan.summary, lookupsSkipped };
      const result = { ...plan, summary };
      if (notAccepted(plan.guard, options) !== undefined) return result;
      await transactional.apply(
        plan.write,
        { summary, at: now() },
        { shouldStop: () => remaining() <= 0 },
      );
      return result;
    });
  }

  async function run(
    options: RefreshOptions,
    onlyIfDue: boolean,
  ): Promise<RefreshOutcome> {
    if (!settings().enabled) return { status: "skipped", reason: "fetch_off" };
    try {
      const locked = await tryWithLock(
        deps.db,
        MODELS_DEV_LOCK,
        async (): Promise<RefreshOutcome> => {
          // Looked at again under the lock: another instance may have fetched while this one waited for its turn.
          if (onlyIfDue && !(await isDue()))
            return { status: "skipped", reason: "not_due" };
          // Before anything is fetched: a run that the platform stops leaves no other trace.
          await repository.recordAttempt(now());
          return work(options);
        },
      );
      return locked.acquired
        ? locked.value
        : { status: "skipped", reason: "already_running" };
    } catch {
      return fail("models_dev_internal");
    }
  }

  async function isDue(): Promise<boolean> {
    const state = await repository.fetchState();
    const current = now().getTime();
    const sinceAttempt =
      state?.lastAttemptAt == null
        ? Infinity
        : current - Date.parse(state.lastAttemptAt);
    // Never fetched: a first run is due at once, a failed or interrupted one an hour after it began.
    if (state === undefined || state.lastSuccessAt === null)
      return sinceAttempt >= RETRY_AFTER_FAILURE_MS;
    // Whatever the last run was, the next waits an hour after it began (a failure, or a run the platform stopped).
    if (sinceAttempt < RETRY_AFTER_FAILURE_MS) return false;
    if (current - Date.parse(state.lastSuccessAt) >= FETCH_INTERVAL_MS)
      return true;
    // The last run left a new provider whose name did not resolve: the next sweep tries again, not the next day.
    return (state.lastSummary?.retryProviders ?? 0) > 0;
  }

  return {
    refresh: (options = {}) => run(options, false),
    refreshIfDue: (options = {}) =>
      run(
        options.deadlineMs === undefined
          ? {}
          : { deadlineMs: options.deadlineMs },
        true,
      ),
  };
}
