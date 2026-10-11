// The stable error codes of the first-run setup and the HTTP status of each. The UI translates a
// code to copy (ui/messages.ts), never the other way round. A code never contains a digit of the
// setup code, a password or a token.

export const SETUP_ERROR_CODES = [
  /** The instance is not set up yet; this part of the app cannot be used before. 503. */
  "setup_required",
  /** The setup code is wrong. The answer does not say how close it was. */
  "invalid_code",
  /** The code is older than 60 minutes; the app has to be restarted for a new one. */
  "code_expired",
  /** The code was already used; it is single use. */
  "code_used",
  /** 10 wrong codes: the endpoint is locked until the app is restarted. */
  "setup_locked",
  /** Too many attempts within a minute; `Retry-After` says when to try again. */
  "rate_limited",
  /** This process printed no setup code (it was not started the way the setup needs). */
  "setup_unavailable",
  /** No valid setup session: enter the code first. */
  "setup_session_required",
  /** The setup session is older than 30 minutes; the app has to be restarted for a new code. */
  "setup_session_expired",
  /** The setup is complete (or somebody else completed it first). */
  "already_set_up",
  /** The request body is not valid; `issues` names the fields. */
  "invalid_input",
  /** An account with the admin's email address exists already. */
  "email_in_use",
  /** The sign in would not accept the admin's email address or password; nothing was created. */
  "admin_unusable",
  /** The request does not come from this site. */
  "cross_site_request",
  /** The body must be application/json. */
  "unsupported_content_type",
  /** The body is larger than the setup allows. */
  "body_too_large",
  /** Not found: the setup does not exist any more (or never did for this request). */
  "not_found",
] as const;
export type SetupErrorCode = (typeof SETUP_ERROR_CODES)[number];

export const SETUP_ERROR_STATUS: Record<SetupErrorCode, number> = {
  setup_required: 503,
  invalid_code: 403,
  code_expired: 410,
  code_used: 409,
  setup_locked: 423,
  rate_limited: 429,
  setup_unavailable: 503,
  setup_session_required: 401,
  setup_session_expired: 401,
  already_set_up: 409,
  invalid_input: 422,
  email_in_use: 409,
  admin_unusable: 422,
  cross_site_request: 403,
  unsupported_content_type: 415,
  body_too_large: 413,
  not_found: 404,
};

export class SetupError extends Error {
  readonly code: SetupErrorCode;
  readonly issues: SetupIssue[];

  constructor(code: SetupErrorCode, issues: SetupIssue[] = []) {
    super(code);
    this.name = "SetupError";
    this.code = code;
    this.issues = issues;
  }
}

/** One problem with one field of the wizard's request, for example `admin.password` and `password_too_short`. */
export type SetupIssue = { field: string; code: string };
