// What a job may do on GitHub and how a failed attempt to get that is reported. The token itself is
// minted by `client.mintInstallationToken` (the one place that does it) and wrapped by the provider.
import { IntegrationError, type IntegrationErrorCode } from "../../errors.ts";
import type { InstallationPermissions } from "./client.ts";
import { GithubAppError } from "./errors.ts";

/**
 * The least a review job needs: write comments and reviews on pull requests and issues, read the
 * code (the runner never pushes), and the metadata every token gets anyway. Nothing else, so a
 * leaked job token cannot change code, settings, workflows or other repositories.
 */
export const JOB_TOKEN_PERMISSIONS: InstallationPermissions = {
  pull_requests: "write",
  issues: "write",
  contents: "read",
  metadata: "read",
};

/** The repository ids a job token is limited to: exactly one, and a real GitHub id. */
export function jobTokenRepositoryIds(repoExternalId: string): number[] | null {
  if (!/^[1-9]\d*$/.test(repoExternalId)) return null;
  const id = Number(repoExternalId);
  return Number.isSafeInteger(id) ? [id] : null;
}

const CODE_FOR: Partial<Record<GithubAppError["code"], IntegrationErrorCode>> =
  {
    GITHUB_APP_NOT_FOUND: "INTEGRATION_ACCESS_CONNECTION_GONE",
    GITHUB_APP_FORBIDDEN: "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
    GITHUB_APP_AUTH_FAILED: "INTEGRATION_ACCESS_APP_AUTH_FAILED",
    GITHUB_APP_RATE_LIMITED: "INTEGRATION_ACCESS_RATE_LIMITED",
    GITHUB_APP_UNAVAILABLE: "INTEGRATION_ACCESS_UNAVAILABLE",
  };

/**
 * Turns whatever went wrong while getting a job token into an `IntegrationError` with a stable,
 * provider neutral code. The message is the GitHub client's own (it names the call and the status,
 * never a credential or a response body); the original error is kept as `cause`.
 *
 * - 404 on the token call: the installation no longer exists.
 * - 403 (not a rate limit): GitHub refuses the app access to the installation. It is normally a
 *   suspended installation, but GitHub does not say why, so a user facing message must stay neutral
 *   ("access to the installation is refused or it is suspended"). A rate limit is checked first.
 * - 422: GitHub refused the narrow scope (repository not in the installation, or a permission the
 *   app does not hold). It never falls back to a broader token.
 */
export function toJobAccessError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (!(error instanceof GithubAppError))
    return new IntegrationError(
      "INTEGRATION_ACCESS_FAILED",
      "Credentials for the job could not be created.",
    );
  const code =
    error.code === "GITHUB_APP_REQUEST_FAILED" && error.status === 422
      ? "INTEGRATION_ACCESS_SCOPE_REFUSED"
      : (CODE_FOR[error.code] ?? "INTEGRATION_ACCESS_FAILED");
  return new IntegrationError(code, error.message, {
    cause: error,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}
