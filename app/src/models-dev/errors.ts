// SPDX-License-Identifier: Apache-2.0

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
