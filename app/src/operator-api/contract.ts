// SPDX-License-Identifier: Apache-2.0

// The vocabulary of the operator API v1 that the code and contracts/operator-api.v1.json share. A test compares
// these lists with the file; the file is the source of the format.
import { ENTITLEMENT_ERROR_CODES } from "../workspaces/entitlements-validation.ts";

export const OPERATOR_API_VERSION = 1;

/** The only credential-free statement the API makes about itself: the largest request body (bytes). */
export const OPERATOR_MAX_BODY_BYTES = 16 * 1024;

/** The longest `field` an error carries (the contract's `ErrorResponse.field`). */
export const MAX_FIELD_LENGTH = 100;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The ids the API accepts for a workspace or a cursor: what the database generates, nothing more exotic. */
export const OPERATOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The codes of the API itself; the codes of a refused entitlement come from the entitlements validation (#271). */
export const OPERATOR_OWN_ERROR_CODES = [
  "unauthorized",
  "not_found",
  "workspace_not_found",
  "method_not_allowed",
  "body_not_allowed",
  "unsupported_media_type",
  "body_too_large",
  "request_invalid",
  "internal_error",
] as const;

export const OPERATOR_API_ERROR_CODES = [
  ...OPERATOR_OWN_ERROR_CODES,
  ...ENTITLEMENT_ERROR_CODES,
] as const;
export type OperatorApiErrorCode = (typeof OPERATOR_API_ERROR_CODES)[number];

/** What a request addresses; the route files decide it, the API does the rest. */
export type OperatorRoute =
  | { kind: "workspaces" }
  | { kind: "workspace-entitlements"; workspaceId: string }
  | { kind: "default-entitlements" }
  | { kind: "unknown" };

/** The methods each kind of route answers. */
export const ROUTE_METHODS: Record<OperatorRoute["kind"], readonly string[]> = {
  workspaces: ["GET"],
  "workspace-entitlements": ["GET", "PUT", "DELETE"],
  "default-entitlements": ["GET", "PUT"],
  unknown: [],
};
