// SPDX-License-Identifier: Apache-2.0

// The stable codes of the admin portal's data routes for the models.dev catalog and the HTTP status of each (#554): the
// confirmation of a changed provider address and "fetch now". The page translates a code to copy, never the other way
// round. A code never contains an address, a name or an answer of models.dev. The codes of a fetch that did not change the
// catalog are those of errors.ts.
import {
  JSON_BODY_ERROR_STATUS,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import {
  MODELS_DEV_FETCH_ERROR_CODES,
  type ModelsDevFetchErrorCode,
} from "./errors.ts";

export const MODELS_DEV_ADMIN_ERROR_CODES = [
  /** The request does not come from this site. */
  "cross_site_request",
  /** The body must be application/json. */
  "unsupported_content_type",
  /** The body is larger than the route accepts. */
  "body_too_large",
  /** The body is not a JSON object. */
  "invalid_input",
  /** The database could not be read or written, so the request was not served. */
  "unavailable",
  /** Not the documented shape: a missing or unknown field, a field of the wrong type. */
  "request_invalid",
  /** The catalog has no such provider. */
  "provider_unknown",
  /** The provider's address is not waiting for a decision (it is trusted again, or was never trusted). */
  "url_not_pending",
  /** The address waiting for a decision is not the one the admin saw (it changed again); read it again. */
  "url_changed_again",
  /** The address was refused (not https, a private address, a port, too long): it cannot be confirmed. */
  "url_refused",
  /** The fetch holds the catalog for longer than a confirmation waits, or one is running; nothing was written, try again. */
  "fetch_in_progress",
  /** The fetch is switched off for this instance (`MODELS_DEV_FETCH`). */
  "fetch_off",
  /** "Fetch now" was asked too often; the answer carries `retryAfterSeconds`. */
  "fetch_rate_limited",
  ...MODELS_DEV_FETCH_ERROR_CODES,
] as const;
export type ModelsDevAdminErrorCode =
  (typeof MODELS_DEV_ADMIN_ERROR_CODES)[number];

const FETCH_STATUS: Record<ModelsDevFetchErrorCode, number> = {
  models_dev_unreachable: 502,
  models_dev_http_status: 502,
  models_dev_too_large: 502,
  models_dev_invalid_json: 502,
  models_dev_invalid_body: 502,
  // The guard refused the fetch: the admin can look at it and accept it.
  models_dev_guard_unlisted_share: 409,
  models_dev_guard_enabled_unlisted: 409,
  models_dev_guard_growth: 409,
  models_dev_guard_url_changed_share: 409,
  models_dev_guard_provider_size: 409,
  models_dev_timeout: 504,
  models_dev_interrupted: 500,
  models_dev_internal: 500,
};

export const MODELS_DEV_ADMIN_ERROR_STATUS: Record<
  ModelsDevAdminErrorCode,
  number
> = {
  ...(JSON_BODY_ERROR_STATUS satisfies Record<JsonBodyErrorCode, number>),
  unavailable: 503,
  request_invalid: 422,
  provider_unknown: 404,
  url_not_pending: 409,
  url_changed_again: 409,
  url_refused: 409,
  fetch_in_progress: 409,
  fetch_off: 409,
  fetch_rate_limited: 429,
  ...FETCH_STATUS,
};
