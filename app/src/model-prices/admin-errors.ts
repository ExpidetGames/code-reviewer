// SPDX-License-Identifier: Apache-2.0

// The stable codes of the data routes for catalog prices and enablement in the admin portal and the HTTP status of each
// (#549). The page translates a code to copy (#554), never the other way round. A code never contains a model id, a price
// or a key. The rules of the confirmation itself have their codes in errors.ts; these add the ones of the route.
import {
  MODEL_PRICE_ERROR_CODES,
  MODEL_PRICE_ERROR_STATUS,
  type ModelPriceErrorCode,
} from "./errors.ts";

export const MODEL_PRICE_ROUTE_ERROR_CODES = [
  /** The request does not come from this site. */
  "cross_site_request",
  /** The body must be application/json. */
  "unsupported_content_type",
  /** The body is larger than the route accepts (64 KB). */
  "body_too_large",
  /** The body is not a JSON object. */
  "invalid_input",
  /** The database could not be read or written, so the request was not served. */
  "unavailable",
  ...MODEL_PRICE_ERROR_CODES,
] as const;
export type ModelPriceRouteErrorCode =
  (typeof MODEL_PRICE_ROUTE_ERROR_CODES)[number];

export const MODEL_PRICE_ROUTE_ERROR_STATUS: Record<
  ModelPriceRouteErrorCode,
  number
> = {
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  invalid_input: 422,
  unavailable: 503,
  ...(MODEL_PRICE_ERROR_STATUS satisfies Record<ModelPriceErrorCode, number>),
};
