// SPDX-License-Identifier: Apache-2.0

// What the catalog screens of the admin portal say (#554). A stable code from a route becomes a sentence here, never the
// other way round; every table is typed over the codes it translates, so a new code is a compile error until it has its
// copy. Admin only: these words name providers, models and prices, which a member never reads.
import type { ManagedUnavailableReason } from "../../model-prices/availability.ts";
import type { PriceWarning } from "../../model-prices/admin-view.ts";
import type { ModelPriceRouteErrorCode } from "../../model-prices/admin-errors.ts";
import type {
  PriceField,
  PriceSource,
  PriceStatus,
} from "../../model-prices/effective-price.ts";
import type { ModelsDevAdminErrorCode } from "../../models-dev/admin-errors.ts";
import {
  GUARD_ERROR_CODES,
  GUARD_REASONS,
  type GuardCode,
  type GuardFigures,
  type ModelsDevFetchErrorCode,
} from "../../models-dev/errors.ts";
import type { UrlProblem, UrlState } from "../../models-dev/upstream-url.ts";
import type { TransportErrorCode } from "../../ui/json-request.ts";
import type { PriceFormIssueCode } from "./price-form.ts";

/** The status of a price, as the badge says it (the words are never colour alone). */
export const PRICE_STATUS_LABEL: Record<PriceStatus, string> = {
  confirmed: "Confirmed",
  stale: "Stale",
  unconfirmed: "Unconfirmed",
  unpriced: "Unpriced",
};

export const PRICE_STATUS_HELP: Record<PriceStatus, string> = {
  confirmed:
    "You confirmed this price and models.dev has not moved it since. The managed key may use the model once it is enabled.",
  stale:
    "models.dev or the override file moved the price after you confirmed it. The managed key refuses the model until you confirm the new price.",
  unconfirmed:
    "Nobody has confirmed this price. The managed key refuses the model until you do.",
  unpriced:
    "models.dev states no price we can read. Enter the price yourself to use the model on the managed key.",
};

export const PRICE_STATUS_ORDER = [
  "confirmed",
  "stale",
  "unconfirmed",
  "unpriced",
] as const satisfies readonly PriceStatus[];

/** The states a model is in for the admin. `new` and `undecided` are both "no decision"; new ones came after the first fetch. */
export type ModelState = "new" | "enabled" | "disabled" | "undecided";
export const MODEL_STATE_LABEL: Record<ModelState, string> = {
  new: "New",
  enabled: "Enabled",
  disabled: "Disabled",
  undecided: "Not decided",
};

/** Warnings about a model that models.dev states or the catalog derives. */
export const MODEL_WARNING_LABEL = {
  unlisted: "Unlisted",
  deprecated: "Deprecated",
  alpha: "Alpha",
  providerBlocked: "Address blocked",
} as const;
export const MODEL_WARNING_HELP: Record<
  keyof typeof MODEL_WARNING_LABEL,
  string
> = {
  unlisted:
    "models.dev no longer lists this model. A confirmed price stays valid and the model stays usable until you disable it.",
  deprecated: "models.dev marks this model as deprecated.",
  alpha: "models.dev marks this model as alpha. It still runs.",
  providerBlocked:
    "The address of this provider changed and waits for you to confirm it. No key is sent to it until then.",
};

export const PRICE_WARNING_COPY: Record<PriceWarning, string> = {
  confirmation_unreadable:
    "The last confirmation of this price could not be read, so the price counts as unconfirmed. Confirm it again to repair it.",
};

export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  catalog: "models.dev",
  override: "Override file",
  admin: "Your correction",
};

export const PRICE_FIELD_LABEL: Record<PriceField, string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite5m: "Cache write, 5 minutes",
  cacheWrite1h: "Cache write, 1 hour",
  reasoning: "Reasoning",
  inputAudio: "Audio in",
  outputAudio: "Audio out",
  contextOver200k: "Over 200k tokens",
  tiers: "Context tiers",
};

/** The fields as they run in a sentence ("differs in: cache read, reasoning"): lower case, no comma inside one. */
export const PRICE_FIELD_SENTENCE: Record<PriceField, string> = {
  input: "input",
  output: "output",
  cacheRead: "cache read",
  cacheWrite5m: "cache write 5 min",
  cacheWrite1h: "cache write 1 h",
  reasoning: "reasoning",
  inputAudio: "audio in",
  outputAudio: "audio out",
  contextOver200k: "price over 200k tokens",
  tiers: "context tiers",
};

/** What a stale price differs in, as a sentence part: "cache read, reasoning". */
export function describeChangedFields(fields: readonly PriceField[]): string {
  return fields.map((field) => PRICE_FIELD_SENTENCE[field]).join(", ");
}

/** Why the managed key refuses a model right now. */
export const MANAGED_REASON_COPY: Record<ManagedUnavailableReason, string> = {
  model_unknown: "The catalog has no such model.",
  provider_unsupported: "The provider is not supported.",
  provider_url_blocked:
    "The provider's address is not trusted: it changed, or it was refused.",
  model_entry_invalid: "The catalog row does not make a usable model.",
  model_blocked: "The override file blocks this model.",
  model_retired: "The override file retired this model.",
  model_not_enabled: "The model is not enabled.",
  price_unconfirmed: "The price is not confirmed.",
  check_failed: "The check failed. Try again.",
};

export const URL_STATE_LABEL: Record<UrlState, string> = {
  trusted: "Trusted",
  url_changed: "Address changed",
  rejected: "Address refused",
};

export const URL_PROBLEM_COPY: Record<UrlProblem, string> = {
  invalid_url: "It is not a usable address.",
  too_long: "It is longer than any address we accept.",
  not_https: "It does not use https.",
  credentials_in_url: "It carries a user name or password.",
  port_not_allowed: "It names a port other than 443.",
  private_address: "It points to a private or special-purpose address.",
  unresolvable:
    "Its name did not resolve. This says nothing about the address; the next fetch looks again.",
  missing: "models.dev states no address and the provider has no default.",
};

/** What the last fetch ended with, for the status line. */
export const FETCH_ERROR_COPY: Record<ModelsDevFetchErrorCode, string> = {
  models_dev_unreachable: "models.dev could not be reached.",
  models_dev_http_status: "models.dev answered with an error status.",
  models_dev_too_large: "The answer of models.dev was larger than we read.",
  models_dev_invalid_json: "The answer of models.dev was not JSON.",
  models_dev_invalid_body: "The answer of models.dev was not a usable catalog.",
  models_dev_guard_unlisted_share:
    "The fetch would unlist an unusually large share of the catalog.",
  models_dev_guard_enabled_unlisted:
    "The fetch would unlist an unusually large share of the models you enabled.",
  models_dev_guard_growth:
    "The fetch would grow the listed models by more than half at once.",
  models_dev_guard_url_changed_share:
    "The fetch would block the addresses of an unusually large share of the providers.",
  models_dev_guard_provider_size:
    "The fetch holds a provider with more models than any provider has; that provider would be left out.",
  models_dev_timeout:
    "The fetch ran out of time before it wrote anything. The catalog is unchanged.",
  models_dev_interrupted:
    "A fetch began and its end was never recorded. The catalog may be unchanged.",
  models_dev_internal: "The fetch ran into an error of its own.",
};

/** The fetch codes that mean the guard stopped the fetch: the admin may look at it and accept it. */
export const GUARD_CODES: readonly GuardCode[] = GUARD_REASONS.map(
  (reason) => GUARD_ERROR_CODES[reason],
);
export type { GuardCode };

export function isGuardCode(code: unknown): code is GuardCode {
  return (GUARD_CODES as readonly unknown[]).includes(code);
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "" : ` (+${String(Math.round((part / whole) * 100))}%)`;

/** What the guard measured for one reason, as a sentence: the figures are numbers, never text from models.dev. */
export function describeGuardFigures(code: GuardCode, f: GuardFigures): string {
  const n = String;
  switch (code) {
    case "models_dev_guard_unlisted_share":
      return f.providersUnlisted > 0
        ? `It would unlist ${n(f.unlisted)} of ${n(f.listed)} listed models and ${n(f.providersUnlisted)} of ${n(f.providersListed)} providers.`
        : `It would unlist ${n(f.unlisted)} of ${n(f.listed)} listed models.`;
    case "models_dev_guard_enabled_unlisted":
      return `It would unlist ${n(f.enabledUnlisted)} of the ${n(f.enabledListed)} models you enabled.`;
    case "models_dev_guard_growth":
      return `The listed models would grow from ${n(f.listed)} to ${n(f.listedAfter)}${percent(f.listedAfter - f.listed, f.listed)}.`;
    case "models_dev_guard_url_changed_share":
      return `It would block the address of ${n(f.newlyBlocked)} of ${n(f.providers)} providers.`;
    case "models_dev_guard_provider_size":
      return `${n(f.oversizedProviders)} provider(s) hold more models than any provider has and would be left out.`;
  }
}

/** The codes a route of the catalog answers with (and the transport's). */
export type CatalogErrorCode =
  ModelPriceRouteErrorCode | ModelsDevAdminErrorCode | TransportErrorCode;

/** Codes that ask the admin to look at the page again: what they saw is not what is stored now. */
export const RELOAD_CODES = [
  "price_changed",
  "url_changed_again",
  "url_not_pending",
] as const satisfies readonly CatalogErrorCode[];
/** Codes after which the same action may simply be tried again. */
export const RETRY_CODES = [
  "fetch_in_progress",
  "unavailable",
  "NETWORK_ERROR",
] as const satisfies readonly CatalogErrorCode[];

export function mustReload(code: string): boolean {
  return (RELOAD_CODES as readonly string[]).includes(code);
}
export function canRetry(code: string): boolean {
  return (RETRY_CODES as readonly string[]).includes(code);
}

const ERROR_COPY: Record<CatalogErrorCode, string> = {
  // The body of a request.
  cross_site_request:
    "The request did not come from this site. Reload the page.",
  unsupported_content_type:
    "The request was not sent as JSON. Reload the page.",
  body_too_large: "The request was too large.",
  invalid_input: "The request was not understood. Reload the page.",
  request_invalid: "The request was not understood. Reload the page.",
  unavailable: "The catalog could not be read or written. Try again.",
  // Models and prices.
  model_unknown: "The catalog no longer has this model. Reload the page.",
  model_blocked:
    "The override file blocks this model, so it cannot be enabled.",
  price_invalid:
    "The price is not valid: enter dollars per million tokens as a number with at most six decimals, not negative and not above $100000, and let the context tiers go up.",
  price_missing:
    "models.dev states no price we can read. Enter the price yourself.",
  price_changed:
    "The catalog price changed while you were looking at it. The page now shows the new price: look at it again before you confirm.",
  reason_invalid:
    "A correction needs a reason of 1 to 500 characters on one line.",
  fetch_in_progress:
    "The daily fetch is writing the catalog right now. Nothing was changed. Try again in a moment.",
  // Providers and the fetch.
  provider_unknown: "The catalog no longer has this provider. Reload the page.",
  url_not_pending:
    "This provider's address is not waiting for a decision any more. Reload the page.",
  url_changed_again:
    "The new address changed while you were looking at it. Nothing was confirmed. Look at the address on the page again.",
  url_refused:
    "This address was refused, so it cannot be confirmed. It is shown as text only.",
  fetch_off:
    "The fetch is switched off for this instance (MODELS_DEV_FETCH), so there is nothing to fetch.",
  fetch_rate_limited:
    "The catalog was fetched too often. Wait a few minutes and try again.",
  ...FETCH_ERROR_COPY,
  // The transport.
  UNAUTHENTICATED: "Your session ended. Sign in again.",
  ACCESS_DENIED: "You may not do this.",
  NETWORK_ERROR: "The server could not be reached. Try again.",
  UNEXPECTED_RESPONSE:
    "The server answered with something the page did not expect. Reload it.",
};

/** The sentence for a code of a route; a code the page does not know says so without showing it. */
export function describeCatalogError(code: string): string {
  return (
    (ERROR_COPY as Record<string, string | undefined>)[code] ??
    "The change was refused. Reload the page and try again."
  );
}

/** The sentence for a field of the correction form. */
export const FORM_ISSUE_COPY: Record<PriceFormIssueCode, string> = {
  required: "Enter a price.",
  negative: "A price cannot be negative.",
  not_a_price:
    "Enter dollars per million tokens as a number with a point, at most six decimals, up to 100000 (for example 2.5).",
  tier_context_invalid:
    "Enter the number of tokens as a whole number above zero.",
  tiers_not_ascending: "A tier must start above the one before it.",
  too_many_tiers: "A price has at most 64 tiers.",
  reason_invalid: "Enter a reason of 1 to 500 characters on one line.",
  free_not_confirmed:
    "A price of 0 means the model is free. Tick the box to say that this is meant.",
};

/** The sentence for an issue the route reports for a field of the request. */
export function describeIssue(code: string): string {
  if (code in FORM_ISSUE_COPY)
    return FORM_ISSUE_COPY[code as PriceFormIssueCode];
  return describeCatalogError(code);
}
