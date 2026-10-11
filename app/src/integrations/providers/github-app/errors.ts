import type { SafeMessageError } from "../../errors.ts";

// Stable error codes of the GitHub App provider. Callers branch on `code`, never on the message. A
// message names the call and the status, never a key, a JWT, a token or a response body.
export const GITHUB_APP_ERROR_CODES = [
  "GITHUB_APP_CONFIG_INVALID",
  /** GitHub refused the App JWT or an installation token (HTTP 401). */
  "GITHUB_APP_AUTH_FAILED",
  /** HTTP 403 that is not a rate limit: the app lacks a permission or the installation is suspended. */
  "GITHUB_APP_FORBIDDEN",
  "GITHUB_APP_NOT_FOUND",
  /** HTTP 429, or 403 with a rate limit header. `retryAfterSeconds` tells when to try again. */
  "GITHUB_APP_RATE_LIMITED",
  /** HTTP 5xx, a network failure or a timeout: worth trying again later. */
  "GITHUB_APP_UNAVAILABLE",
  /** Any other unexpected answer, including a body that is not what the API documents. */
  "GITHUB_APP_REQUEST_FAILED",
] as const;

export type GithubAppErrorCode = (typeof GITHUB_APP_ERROR_CODES)[number];

export class GithubAppError extends Error implements SafeMessageError {
  /** The messages of this provider name calls and statuses only; see `hasSafeMessage`. */
  readonly safeMessage = true as const;
  readonly code: GithubAppErrorCode;
  /** HTTP status of the answer; null for a network failure, a timeout or a configuration error. */
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: GithubAppErrorCode,
    message: string,
    options: {
      status?: number | null;
      retryAfterSeconds?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "GithubAppError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export type GithubAppConfigProblemKind = "missing" | "invalid";

/** The configuration is missing or invalid. `variables` are the names involved, never their values. */
export class GithubAppConfigError extends GithubAppError {
  readonly variables: readonly string[];
  readonly problem: GithubAppConfigProblemKind;

  constructor(
    variables: readonly string[],
    problem: GithubAppConfigProblemKind,
  ) {
    super(
      "GITHUB_APP_CONFIG_INVALID",
      `GitHub App configuration is invalid (${problem}): ${variables.join(", ")}.`,
    );
    this.name = "GithubAppConfigError";
    this.variables = variables;
    this.problem = problem;
  }
}
