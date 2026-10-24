// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of a models.dev fetch that did not change the catalog (#548). They are stored (`last_error` of the
// fetch state), logged and shown by a caller; nothing the upstream said, and no address, is ever part of one.

export const MODELS_DEV_FETCH_ERROR_CODES = [
  /** The connection failed, a name did not resolve, or the time ran out. */
  "models_dev_unreachable",
  /** models.dev answered with a status other than 200 (a redirect included). */
  "models_dev_http_status",
  /** The body is larger than the cap; reading stopped. */
  "models_dev_too_large",
  /** The body is not JSON. */
  "models_dev_invalid_json",
  /** The body is JSON but not a usable catalog (not an object of providers, or not one usable model). */
  "models_dev_invalid_body",
  /** Applying the body would unlist an implausibly large share of the catalog; the old state stays. */
  "models_dev_guard_unlisted_share",
  /** Applying the body would unlist an implausibly large share of the models an admin enabled for the managed key (#549); the old state stays. */
  "models_dev_guard_enabled_unlisted",
  /** Applying the body would make the listed models grow by more than half in one fetch; the old state stays. */
  "models_dev_guard_growth",
  /** Applying the body would block the addresses of an implausibly large share of the providers at once. */
  "models_dev_guard_url_changed_share",
  /** The body holds a provider with more models than any provider has; that provider is not read. */
  "models_dev_guard_provider_size",
  /** The time of the run (one deadline for the fetch, the lookups and the write) was used up before the write; nothing was written. */
  "models_dev_timeout",
  /** A run began and its end was never recorded (the platform stopped it): only the start of the attempt is known. */
  "models_dev_interrupted",
  /** The fetch ran into an error of our own (the database, most likely). */
  "models_dev_internal",
] as const;
export type ModelsDevFetchErrorCode =
  (typeof MODELS_DEV_FETCH_ERROR_CODES)[number];

export function isModelsDevFetchErrorCode(
  value: string,
): value is ModelsDevFetchErrorCode {
  return (MODELS_DEV_FETCH_ERROR_CODES as readonly string[]).includes(value);
}

/** Why the guard refuses a fetch (`plan.ts`), and the stable code each reason is recorded as. */
export const GUARD_ERROR_CODES = {
  unlisted_share: "models_dev_guard_unlisted_share",
  enabled_unlisted_share: "models_dev_guard_enabled_unlisted",
  growth: "models_dev_guard_growth",
  url_changed_share: "models_dev_guard_url_changed_share",
  provider_size: "models_dev_guard_provider_size",
} as const satisfies Record<string, ModelsDevFetchErrorCode>;
export type GuardReason = keyof typeof GUARD_ERROR_CODES;
export type GuardCode = (typeof GUARD_ERROR_CODES)[GuardReason];

/** Every reason, in the fixed order the guard reports them. */
export const GUARD_REASONS = Object.keys(GUARD_ERROR_CODES) as GuardReason[];

/** The reason a stable guard code stands for; `undefined` for anything else. */
export function guardReasonOfCode(code: unknown): GuardReason | undefined {
  return GUARD_REASONS.find((reason) => GUARD_ERROR_CODES[reason] === code);
}

/**
 * What the guard measured, for the admin to judge a refused fetch: numbers only, never a name or an address. Models are
 * the catalog's models, providers the providers of the catalog.
 */
export type GuardFigures = {
  /** Models this fetch would unlist, and the models that were listed before it. */
  unlisted: number;
  listed: number;
  /** Models that would be listed after it (growth is measured against `listed`). */
  listedAfter: number;
  /** Providers this fetch would unlist, and the providers that were listed before it. */
  providersUnlisted: number;
  providersListed: number;
  /** Models an admin enabled that it would unlist, and the enabled models that were listed before it. */
  enabledUnlisted: number;
  enabledListed: number;
  /** Providers whose address it would newly block, of the providers it states. */
  newlyBlocked: number;
  providers: number;
  /** Providers it holds with more models than any provider has (left out). */
  oversizedProviders: number;
};

/** Thrown by the write when the caller's time is up between two batches; the transaction is rolled back. */
export class ModelsDevDeadlineError extends Error {
  readonly code = "models_dev_timeout" as const;
  constructor() {
    super("The time for the models.dev write is used up.");
  }
}
