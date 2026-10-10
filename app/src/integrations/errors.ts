// Stable error codes of the integrations layer. Callers branch on `code`, never on the message.
export const INTEGRATION_ERROR_CODES = [
  "INTEGRATION_TYPE_UNKNOWN",
  "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
  "INTEGRATION_CONFIG_INVALID",
  "INTEGRATION_SECRET_NOT_ALLOWED",
  "INTEGRATION_ALREADY_EXISTS",
  "INTEGRATION_NOT_FOUND",
  "INTEGRATION_EXTERNAL_ID_REQUIRED",
  "INTEGRATION_STATUS_INVALID",
  "INTEGRATION_PULL_REQUEST_NOT_FOUND",
  // Why `jobAccess` could not hand out credentials. Provider neutral, so a caller (the runner API's
  // claim) branches on these and never on a platform's own codes. See `isRetryableAccessFailure`.
  /** The connection was removed on the platform (GitHub: the installation was deleted). */
  "INTEGRATION_ACCESS_CONNECTION_GONE",
  /** The platform has paused the connection (GitHub: the installation is suspended). */
  "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
  /**
   * The platform refused the narrowly scoped credentials: the repository is not (or no longer)
   * part of the connection, or the app is not granted the permissions a job needs. No broader
   * credentials are tried instead.
   */
  "INTEGRATION_ACCESS_SCOPE_REFUSED",
  /** The platform did not accept the app's own identity (GitHub: the App JWT, so key or app id). */
  "INTEGRATION_ACCESS_APP_AUTH_FAILED",
  /** Retryable. `retryAfterSeconds` says when, if the platform told. */
  "INTEGRATION_ACCESS_RATE_LIMITED",
  /** Retryable: the platform answered 5xx, could not be reached or took too long. */
  "INTEGRATION_ACCESS_UNAVAILABLE",
  /** Anything else: bad settings, an unusable repository reference, an unexpected answer. */
  "INTEGRATION_ACCESS_FAILED",
  /** A `GitAccess` without a token was asked to reveal it (see `revealGitAccess`). */
  "INTEGRATION_ACCESS_TOKEN_MISSING",
] as const;

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

/**
 * Marks an error whose message is known to be free of secrets (it names calls, statuses and
 * variable names, never a key, token or response body), so it may be logged and shown as it is. Any
 * error without the marker is reduced to a generic line wherever it is reported.
 */
export type SafeMessageError = Error & { readonly safeMessage: true };

export function hasSafeMessage(error: unknown): error is SafeMessageError {
  return (
    error instanceof Error &&
    (error as { safeMessage?: unknown }).safeMessage === true
  );
}

/** The access failures that are worth trying again later without anybody changing anything. */
const RETRYABLE_ACCESS_CODES: readonly IntegrationErrorCode[] = [
  "INTEGRATION_ACCESS_RATE_LIMITED",
  "INTEGRATION_ACCESS_UNAVAILABLE",
];

export class IntegrationError extends Error implements SafeMessageError {
  readonly safeMessage = true as const;
  readonly code: IntegrationErrorCode;
  /** True when trying the same call again later can succeed (a rate limit, platform down). */
  readonly retryable: boolean;
  /** For a rate limit: how long the platform asked to wait; otherwise null. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: IntegrationErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number | null },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "IntegrationError";
    this.code = code;
    this.retryable = RETRYABLE_ACCESS_CODES.includes(code);
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }
}
