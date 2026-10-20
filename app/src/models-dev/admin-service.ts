// SPDX-License-Identifier: Apache-2.0

// What the admin portal does with the models.dev catalog besides the prices (#554): the providers with the state of their
// addresses, the confirmation of an address that changed, and "fetch now".
//
// **Confirming an address** is the guarded update of the one provider row, in a transaction of its own
// (`confirmPendingUrl`, src/db/repositories/models-dev-repository.ts): only the address the admin saw, only while it is
// waiting for a decision, never a refused one. It does not take `MODELS_DEV_LOCK`. The fetch reads the provider rows
// `FOR UPDATE` on Postgres inside the transaction that writes them, so this transaction reads the row `FOR UPDATE` first,
// waits for a fetch that is writing for at most `lockTimeoutMs` (then `fetch_in_progress`, nothing written) and is applied
// after it; on SQLite every transaction begins `begin immediate`.
//
// **Fetch now** is `refresh()` with a deadline that fits the function limit of the route (`FETCH_NOW_DEADLINE_MS`, below
// the 60 seconds of `vercel.json`), counted in the shared rate limits. A fetch the guard refused is answered with every
// reason that tripped and what it measured; the admin who has looked at them repeats the request with `acceptReasons`, the
// reasons they accept, and a reason that is new or not named refuses it again. Every write leaves one line in the log: the person, the provider and the addresses
// (which passed the address check) or the outcome; never a name or an answer of models.dev.
import "server-only";
import type { Kysely } from "kysely";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { isLockTimeout, setLockTimeout } from "../db/lock-timeout.ts";
import type { Database } from "../db/schema.ts";
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { ModelsDevAdminErrorCode } from "./admin-errors.ts";
import type { FetchSummary, StoredProvider } from "./catalog.ts";
import {
  GUARD_ERROR_CODES,
  guardReasonOfCode,
  type GuardCode,
  type GuardFigures,
  type GuardReason,
  type ModelsDevFetchErrorCode,
} from "./errors.ts";
import type { ModelsDevService, RefreshOutcome } from "./service.ts";
import { loadModelsDevSettings, type ModelsDevSettings } from "./settings.ts";
import type { UrlProblem, UrlState } from "./upstream-url.ts";

/**
 * The whole run of an admin's "fetch now": below the 60 seconds a route of the hosted deployment runs (`vercel.json`,
 * pinned by a test), so that the run ends with `models_dev_timeout` and writes nothing instead of being cut off.
 */
export const FETCH_NOW_DEADLINE_MS = 45_000;
export const FETCH_NOW_MAX = 6;
export const FETCH_NOW_WINDOW_MS = 10 * 60 * 1000;
const FETCH_NOW_KEY = "models-dev-fetch-now";
/** The guard has five reasons; a longer list cannot be a valid one. */
const MAX_ACCEPTED_REASONS = 5;
/** How long a confirmation waits for the fetch's lock on Postgres before it gives up with `fetch_in_progress`. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

/** A provider as the admin sees it. The strings are untrusted text from models.dev; the page escapes them. */
export type ProviderView = {
  id: string;
  name: string;
  /** False once models.dev lists no model of the provider. */
  listed: boolean;
  url: {
    state: UrlState;
    trustedUrl: string | null;
    /** The address waiting for a decision, or the text of a refused one (raw, untrusted). */
    pendingUrl: string | null;
    problem: UrlProblem | null;
  };
  urlChangedAt: string | null;
  /** How many listed models of the provider the catalog holds. */
  models: number;
};

export type ProviderList = {
  providers: ProviderView[];
  /** False when `MODELS_DEV_FETCH` switches the fetch off: "fetch now" does nothing then. */
  fetchEnabled: boolean;
};

type Refusal<Code extends ModelsDevAdminErrorCode> = { ok: false; code: Code };
export type UrlConfirmRefusalCode = Extract<
  ModelsDevAdminErrorCode,
  | "request_invalid"
  | "provider_unknown"
  | "url_not_pending"
  | "url_changed_again"
  | "url_refused"
  | "fetch_in_progress"
>;
export type UrlConfirmResult =
  { ok: true; provider: ProviderView } | Refusal<UrlConfirmRefusalCode>;

export type FetchNowRefusalCode = Extract<
  ModelsDevAdminErrorCode,
  | ModelsDevFetchErrorCode
  | "request_invalid"
  | "fetch_off"
  | "fetch_in_progress"
  | "fetch_rate_limited"
>;
/** Why the guard stopped a fetch, as the admin reads it: the stable code of every reason and what the guard measured. */
export type GuardDetails = { reasons: GuardCode[]; details: GuardFigures };

export type FetchNowResult =
  | { ok: true; outcome: "applied"; summary: FetchSummary }
  | {
      ok: false;
      code: FetchNowRefusalCode;
      retryAfterSeconds?: number;
      /** Present when the guard stopped the fetch. */
      guard?: GuardDetails;
    };

export type ModelsDevAdminService = {
  providers(): Promise<ProviderList>;
  /** `{ providerId, pendingUrl }`: trusts the address the admin saw. */
  confirmUrl(actorId: string, input: unknown): Promise<UrlConfirmResult>;
  /** `{}` or `{ acceptReasons: GuardCode[] }`: the guard's codes the admin accepts, each at most once. */
  fetchNow(actorId: string, input: unknown): Promise<FetchNowResult>;
};

export type ModelsDevAdminServiceDependencies = {
  db: Kysely<Database>;
  models: Pick<ModelsDevService, "refresh">;
  rateLimits: RateLimitsRepository;
  settings?: () => ModelsDevSettings;
  lockTimeoutMs?: number;
  now?: () => Date;
  /** Where the audit line goes (the server's log in production, a list in tests). */
  log?: { info(line: string): void };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The guard reasons a request accepts: none when it names none, `undefined` when the body is not the documented one (a field
 * other than `acceptReasons`, a list that is not made of the guard's codes, a code twice).
 */
function acceptedReasons(
  input: Record<string, unknown>,
): GuardReason[] | undefined {
  const keys = Object.keys(input);
  if (keys.length === 0) return [];
  if (keys.length !== 1 || keys[0] !== "acceptReasons") return undefined;
  const list = input.acceptReasons;
  if (!Array.isArray(list) || list.length > MAX_ACCEPTED_REASONS)
    return undefined;
  const reasons: GuardReason[] = [];
  for (const code of list as unknown[]) {
    const reason = guardReasonOfCode(code);
    if (reason === undefined || reasons.includes(reason)) return undefined;
    reasons.push(reason);
  }
  return reasons;
}

function viewOf(provider: StoredProvider, models: number): ProviderView {
  return {
    id: provider.id,
    name: provider.name,
    listed: provider.unlistedAt === null,
    url: {
      state: provider.url.state,
      trustedUrl: provider.url.trustedUrl,
      pendingUrl: provider.url.pendingUrl,
      problem: provider.url.problem,
    },
    urlChangedAt: provider.urlChangedAt,
    models,
  };
}

const NOT_AN_OUTCOME: Record<
  Extract<RefreshOutcome, { status: "skipped" }>["reason"],
  FetchNowRefusalCode
> = {
  fetch_off: "fetch_off",
  already_running: "fetch_in_progress",
  // `refresh()` fetches whether or not a fetch is due; this is only here to be total.
  not_due: "models_dev_internal",
};

export function createModelsDevAdminService(
  deps: ModelsDevAdminServiceDependencies,
): ModelsDevAdminService {
  const { db } = deps;
  const settings = deps.settings ?? (() => loadModelsDevSettings(process.env));
  const log = deps.log ?? { info: (line: string) => console.info(line) };
  const now = deps.now ?? (() => new Date());
  const lockTimeoutMs = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const catalog = createModelsDevRepository(db);

  async function providerView(
    id: string,
    repository = catalog,
  ): Promise<ProviderView | undefined> {
    const [provider, models] = await Promise.all([
      repository.getProvider(id),
      repository.listModels(),
    ]);
    if (provider === undefined) return undefined;
    return viewOf(
      provider,
      models.filter((m) => m.providerId === id && m.unlistedAt === null).length,
    );
  }

  return {
    async providers() {
      const [providers, models] = await Promise.all([
        catalog.listProviders(),
        catalog.listModels(),
      ]);
      const count = new Map<string, number>();
      for (const model of models)
        if (model.unlistedAt === null)
          count.set(model.providerId, (count.get(model.providerId) ?? 0) + 1);
      return {
        providers: providers.map((p) => viewOf(p, count.get(p.id) ?? 0)),
        fetchEnabled: settings().enabled,
      };
    },

    async confirmUrl(actorId, input) {
      if (!isRecord(input) || Object.keys(input).length !== 2)
        return { ok: false, code: "request_invalid" };
      const { providerId, pendingUrl } = input;
      if (
        typeof providerId !== "string" ||
        providerId === "" ||
        typeof pendingUrl !== "string" ||
        pendingUrl === ""
      )
        return { ok: false, code: "request_invalid" };
      const outcome = await db
        .transaction()
        .execute(
          async (
            trx,
          ): Promise<
            | { ok: true; trusted: string | null }
            | Refusal<UrlConfirmRefusalCode>
          > => {
            await setLockTimeout(trx, lockTimeoutMs);
            const repository = createModelsDevRepository(trx);
            // The lock the fetch holds while it writes: wait for a fetch, then judge what it wrote.
            const provider = await repository.getProvider(providerId, {
              forUpdate: true,
            });
            if (provider === undefined)
              return { ok: false, code: "provider_unknown" };
            // A refused address has no confirmation, whatever state the provider is in.
            if (provider.url.problem !== null)
              return { ok: false, code: "url_refused" };
            if (provider.url.state !== "url_changed")
              return { ok: false, code: "url_not_pending" };
            if (provider.url.pendingUrl !== pendingUrl)
              return { ok: false, code: "url_changed_again" };
            if (!(await repository.confirmPendingUrl(providerId, pendingUrl)))
              return { ok: false, code: "url_changed_again" };
            return { ok: true, trusted: provider.url.trustedUrl };
          },
        )
        .catch((error: unknown): Refusal<"fetch_in_progress"> => {
          // The fetch kept its lock for longer than we wait: nothing was written, and the admin tries again.
          if (isLockTimeout(error))
            return { ok: false, code: "fetch_in_progress" };
          throw error;
        });
      if (!outcome.ok) return outcome;
      // The addresses passed the address check (https, no whitespace), and are quoted so a line cannot be split.
      log.info(
        `models.dev: PROVIDER_URL_CONFIRMED by=${actorId} provider=${JSON.stringify(providerId)} old=${JSON.stringify(outcome.trusted)} new=${JSON.stringify(pendingUrl)}`,
      );
      const provider = await providerView(providerId);
      return provider === undefined
        ? { ok: false, code: "provider_unknown" }
        : { ok: true, provider };
    },

    async fetchNow(actorId, input) {
      if (!isRecord(input)) return { ok: false, code: "request_invalid" };
      const accepted = acceptedReasons(input);
      if (accepted === undefined) return { ok: false, code: "request_invalid" };
      if (!settings().enabled) return { ok: false, code: "fetch_off" };
      const hit = await deps.rateLimits.hit(FETCH_NOW_KEY, FETCH_NOW_WINDOW_MS);
      if (hit.count > FETCH_NOW_MAX)
        return {
          ok: false,
          code: "fetch_rate_limited",
          retryAfterSeconds: secondsLeft(
            hit.windowStartedAt,
            FETCH_NOW_WINDOW_MS,
            now(),
          ),
        };
      const outcome = await deps.models.refresh({
        deadlineMs: FETCH_NOW_DEADLINE_MS,
        ...(accepted.length > 0 ? { acceptReasons: accepted } : {}),
      });
      const result: FetchNowResult =
        outcome.status === "applied"
          ? { ok: true, outcome: "applied", summary: outcome.summary }
          : outcome.status === "failed"
            ? {
                ok: false,
                code: outcome.code,
                ...(outcome.guard === undefined
                  ? {}
                  : {
                      guard: {
                        reasons: outcome.guard.reasons.map(
                          (reason) => GUARD_ERROR_CODES[reason],
                        ),
                        details: outcome.guard.figures,
                      },
                    }),
              }
            : { ok: false, code: NOT_AN_OUTCOME[outcome.reason] };
      log.info(
        `models.dev: FETCH_NOW by=${actorId} accept_reasons=${accepted.map((reason) => GUARD_ERROR_CODES[reason]).join(",") || "none"} outcome=${result.ok ? "applied" : result.code}`,
      );
      return result;
    },
  };
}
