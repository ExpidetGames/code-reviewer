// The stable error codes of starting a review by hand. A caller (the route, a test) branches on
// `code`, never on the message; the UI translates codes to copy.
export const MANUAL_REVIEW_ERROR_CODES = [
  /** The body is not usable (`issues` names the fields), or the repository id is malformed. 400. */
  "MANUAL_REVIEW_REQUEST_INVALID",
  /** The request does not come from this site (cross-site `Sec-Fetch-Site` or a foreign `Origin`). 403. */
  "MANUAL_REVIEW_CROSS_SITE_REQUEST",
  /** The body is larger than the limit. 413. */
  "MANUAL_REVIEW_BODY_TOO_LARGE",
  /** The content type is not `application/json`. 415. */
  "MANUAL_REVIEW_CONTENT_TYPE_UNSUPPORTED",
  /** No repository has this id, or it has no active project. Both look the same from outside. 404. */
  "MANUAL_REVIEW_PROJECT_NOT_FOUND",
  /** The platform does not know a pull request with this number in the repository. 404. */
  "MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND",
  /** The pull request is closed or merged. 409. */
  "MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN",
  /** The project switched this command off in its settings. 409. */
  "MANUAL_REVIEW_COMMAND_NOT_ALLOWED",
  /** The app is no longer installed for the repository, or the platform refuses it access. 409. */
  "MANUAL_REVIEW_APP_NOT_INSTALLED",
  /** The platform could not be asked, answered with an error, or answered with something unusable. 502. */
  "MANUAL_REVIEW_GITHUB_UNAVAILABLE",
] as const;
export type ManualReviewErrorCode = (typeof MANUAL_REVIEW_ERROR_CODES)[number];

/** The HTTP status each code is answered with. */
export const MANUAL_REVIEW_ERROR_STATUS: Record<
  ManualReviewErrorCode,
  400 | 403 | 404 | 409 | 413 | 415 | 502
> = {
  MANUAL_REVIEW_REQUEST_INVALID: 400,
  MANUAL_REVIEW_CROSS_SITE_REQUEST: 403,
  MANUAL_REVIEW_BODY_TOO_LARGE: 413,
  MANUAL_REVIEW_CONTENT_TYPE_UNSUPPORTED: 415,
  MANUAL_REVIEW_PROJECT_NOT_FOUND: 404,
  MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND: 404,
  MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN: 409,
  MANUAL_REVIEW_COMMAND_NOT_ALLOWED: 409,
  MANUAL_REVIEW_APP_NOT_INSTALLED: 409,
  MANUAL_REVIEW_GITHUB_UNAVAILABLE: 502,
};

/** One field of the body that cannot be used. */
export type ManualReviewIssue = {
  field: "prNumber" | "command" | "question";
  code: "required" | "invalid" | "too_long";
};

export class ManualReviewError extends Error {
  readonly code: ManualReviewErrorCode;
  readonly issues: readonly ManualReviewIssue[];
  /** The message names the code's meaning only, never a value from the request or from GitHub. */
  readonly safeMessage = true as const;

  constructor(
    code: ManualReviewErrorCode,
    message: string,
    issues: readonly ManualReviewIssue[] = [],
  ) {
    super(message);
    this.name = "ManualReviewError";
    this.code = code;
    this.issues = issues;
  }
}
