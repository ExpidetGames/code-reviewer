// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable error codes of the catalog data routes of the admin portal and the HTTP status of each (#429). The page
// translates a code to copy (src/admin/ui/catalog-messages.ts), never the other way round. A code never contains a
// model id, a provider answer or a key. The rules of the catalog itself have their codes in errors.ts; these add the
// ones of the route.
import { CATALOG_ERROR_CODES, type CatalogErrorCode } from "./errors.ts";

export const CATALOG_ROUTE_ERROR_CODES = [
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
  /** The model behind a released entry changes only with `confirmModelChange: true`; `projects` says how many projects use it. */
  "model_change_not_confirmed",
  ...CATALOG_ERROR_CODES,
] as const;
export type CatalogRouteErrorCode = (typeof CATALOG_ROUTE_ERROR_CODES)[number];

const CATALOG_STATUS: Record<CatalogErrorCode, number> = {
  request_invalid: 422,
  name_invalid: 422,
  name_reveals_model: 422,
  catalog_name_taken: 409,
  description_invalid: 422,
  PROVIDER_UNKNOWN: 422,
  model_id_invalid: 422,
  kinds_invalid: 422,
  CATALOG_ENTRY_UNKNOWN: 404,
  CATALOG_ENTRY_NOT_RELEASED: 409,
  CATALOG_ENTRY_KIND_MISMATCH: 409,
  catalog_transition_invalid: 409,
  catalog_entry_not_draft: 409,
  catalog_entry_is_default: 409,
  catalog_conflict: 409,
  MODEL_UNKNOWN: 422,
  DYNAMIC_MODEL_TOOLS_UNSUPPORTED: 422,
  DYNAMIC_MODEL_UNKNOWN: 422,
  // The provider could not be asked, so the model cannot be accepted for Dynamic: a refusal of the entry like the others
  // (the review settings refuse it as a field problem too). Not a 5xx: a proxy or a CDN may swap the body of a 502 for
  // its own page, and the page would lose the sentence.
  DYNAMIC_MODEL_UNVERIFIED: 422,
};

export const CATALOG_ROUTE_ERROR_STATUS: Record<CatalogRouteErrorCode, number> =
  {
    cross_site_request: 403,
    unsupported_content_type: 415,
    body_too_large: 413,
    invalid_input: 422,
    unavailable: 503,
    model_change_not_confirmed: 409,
    ...CATALOG_STATUS,
  };
