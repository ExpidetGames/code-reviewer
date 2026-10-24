// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable error codes of the review settings routes and service. A caller (the UI, a test)
// branches on `code`, never on the message; the UI translates codes to copy.
import type { ReviewSettingIssue } from "./validate.ts";

export const REVIEW_SETTINGS_ERROR_CODES = [
  /** One or more settings are not valid; `issues` names the fields. 400. */
  "REVIEW_SETTINGS_INVALID",
  /** The body is not JSON, or not `{ "settings": { ... } }`. 400. */
  "REVIEW_SETTINGS_REQUEST_INVALID",
  /** The request does not come from this site (cross-site `Sec-Fetch-Site` or a foreign `Origin`). 403. */
  "REVIEW_SETTINGS_CROSS_SITE_REQUEST",
  /** The body is larger than the limit. 413. */
  "REVIEW_SETTINGS_BODY_TOO_LARGE",
  /** The content type is not `application/json`. 415. */
  "REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED",
  /** There is no such repository (unknown, or no longer listed by the platform and without a project). 404. */
  "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
  /**
   * The save would write or move the address pinned for a catalog provider (#588) and the person may not manage the workspace's
   * LLM key; an Owner or Admin confirms it. Nothing was stored. 403.
   */
  "PROVIDER_ADDRESS_CONFIRM_FORBIDDEN",
  /**
   * The save would pin an address for a catalog provider that another project of the workspace holds differently (#614), for
   * example a model-only save of a selection from before pins, and the person may not manage the workspace's LLM key. Nothing
   * was stored. 403.
   */
  "PROVIDER_ADDRESS_OTHER_PROJECT_PIN",
] as const;
export type ReviewSettingsErrorCode =
  (typeof REVIEW_SETTINGS_ERROR_CODES)[number];

export const REVIEW_SETTINGS_ERROR_STATUS: Record<
  ReviewSettingsErrorCode,
  400 | 403 | 404 | 413 | 415
> = {
  PROVIDER_ADDRESS_CONFIRM_FORBIDDEN: 403,
  PROVIDER_ADDRESS_OTHER_PROJECT_PIN: 403,
  REVIEW_SETTINGS_INVALID: 400,
  REVIEW_SETTINGS_REQUEST_INVALID: 400,
  REVIEW_SETTINGS_CROSS_SITE_REQUEST: 403,
  REVIEW_SETTINGS_BODY_TOO_LARGE: 413,
  REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED: 415,
  REVIEW_SETTINGS_PROJECT_NOT_FOUND: 404,
};

export class ReviewSettingsError extends Error {
  readonly code: ReviewSettingsErrorCode;
  /** For `REVIEW_SETTINGS_INVALID`: which fields are wrong and why. Codes and field names only. */
  readonly issues: readonly ReviewSettingIssue[];
  /** The message names the code's meaning only, never a value from the request. */
  readonly safeMessage = true as const;

  constructor(
    code: ReviewSettingsErrorCode,
    message: string,
    issues: readonly ReviewSettingIssue[] = [],
  ) {
    super(message);
    this.name = "ReviewSettingsError";
    this.code = code;
    this.issues = issues;
  }
}
