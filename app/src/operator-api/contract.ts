// SPDX-License-Identifier: LicenseRef-Proprietary

// The vocabulary of the operator API v1 that the code and contracts/operator-api.v1.json share. A test compares
// these lists with the file; the file is the source of the format.
import { PLAN_MANAGEMENT_URL_ERROR_CODES } from "../plan-handoff/url.ts";
import { ENTITLEMENT_ERROR_CODES } from "../workspaces/entitlements-validation.ts";

export const OPERATOR_API_VERSION = 1;

/** The only credential-free statement the API makes about itself: the largest request body (bytes). */
export const OPERATOR_MAX_BODY_BYTES = 16 * 1024;

/** The longest `field` an error carries (the contract's `ErrorResponse.field`). */
export const MAX_FIELD_LENGTH = 100;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** A timestamp as the API writes and reads it: ISO 8601, UTC, milliseconds (the contract's `Timestamp`). */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** True for a real instant written exactly like that (month 13 or the 31st of February is not one). */
export function isTimestamp(text: string): boolean {
  if (!TIMESTAMP_PATTERN.test(text)) return false;
  const time = Date.parse(text);
  return !Number.isNaN(time) && new Date(time).toISOString() === text;
}

/** The ids the API accepts for a workspace or a cursor: what the database generates, nothing more exotic. */
export const OPERATOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * How old a settled usage record must be before the feed serves it (#278). A settlement is stamped with the time
 * of its statement but becomes visible when its transaction commits, so two settlements can become visible in the
 * reverse order of their stamps. A reader that has moved past a position would never see the later arrival; with
 * this lag the feed only serves records older than any transaction that is still allowed to be open. A fixed
 * instance constant, checked by `validateSafetyLagMs` (usage-cursor.ts).
 */
export const USAGE_SAFETY_LAG_MS = 60_000;

/**
 * What a usage item may show as `modelTier`: a short lowercase tier name. No `/` and no `.`, so the id of a model
 * (`vendor/model-4.5`) is never served as a tier (the contract's `UsageItem.modelTier.pattern`).
 */
export const TIER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** What a usage item may show as `catalogEntryId`: the shape of an entry id (the contract's pattern). At most 64 characters. */
export const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest cursor the feed accepts (the contract's `UsageCursor.maxLength`). */
export const MAX_USAGE_CURSOR_LENGTH = 128;

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
  "cursor_invalid",
  "period_invalid",
  /** The handoff token is not (or no longer) valid: unknown, used, expired, revoked, or its person lost the role (#284). */
  "invalid_token",
  "internal_error",
] as const;

export const OPERATOR_API_ERROR_CODES = [
  ...OPERATOR_OWN_ERROR_CODES,
  ...ENTITLEMENT_ERROR_CODES,
  ...PLAN_MANAGEMENT_URL_ERROR_CODES,
] as const;
export type OperatorApiErrorCode = (typeof OPERATOR_API_ERROR_CODES)[number];

/** What a request addresses; the route files decide it, the API does the rest. */
export type OperatorRoute =
  | { kind: "workspaces" }
  | { kind: "workspace-entitlements"; workspaceId: string }
  | { kind: "default-entitlements" }
  | { kind: "usage" }
  | { kind: "usage-unknown-cost" }
  | { kind: "workspace-usage"; workspaceId: string }
  | { kind: "workspace-usage-summary"; workspaceId: string }
  | { kind: "plan-management" }
  | { kind: "handoff-redeem" }
  | { kind: "unknown" };

/** The methods each kind of route answers. */
export const ROUTE_METHODS: Record<OperatorRoute["kind"], readonly string[]> = {
  workspaces: ["GET"],
  "workspace-entitlements": ["GET", "PUT", "DELETE"],
  "default-entitlements": ["GET", "PUT"],
  usage: ["GET"],
  "usage-unknown-cost": ["GET"],
  "workspace-usage": ["GET"],
  "workspace-usage-summary": ["GET"],
  "plan-management": ["GET", "PUT", "DELETE"],
  "handoff-redeem": ["POST"],
  unknown: [],
};
