// SPDX-License-Identifier: LicenseRef-Proprietary

// Asks GitHub whether the signed in account is a member of the allowed organization. It uses the
// account's own token on `GET /user/memberships/orgs/{org}`, which needs the `read:org` scope and
// also sees private memberships (the public members list would not).
//
// The answer is one of four values. Only a clear yes is "member". A clear no is "not_member". A
// token GitHub no longer accepts is "token_invalid". Everything else (missing scope or rate limit
// as 403, an outage, a malformed body, a timeout) is "unavailable": the caller must treat that as a
// no, but it is not proof that the person left the organization.
//
// GitHub names the scopes of an OAuth token in the `X-OAuth-Scopes` header of every answer. A token
// without `read:org` can neither be told "not a member" from "cannot see" nor ever succeed, so that
// is reported as `token_invalid` (the person signs in again and grants the scope) instead of as a
// membership answer. The stored scope on the account is not used: Better Auth writes it once, when
// the account is created, so it would be stale after the first later sign in.
//
// The token is only sent in the Authorization header; it never appears in an error or a log line.

export type OrgMembership =
  "member" | "not_member" | "token_invalid" | "unavailable";

/** How long the check may take while a person waits (a sign in or a page). */
export const ORG_CHECK_TIMEOUT_MS = 5_000;

const ORG_SCOPES = ["read:org", "write:org", "admin:org"];

export type CheckOrgMembershipOptions = {
  /** Base URL of the GitHub API, without a trailing slash. */
  apiBaseUrl: string;
  org: string;
  accessToken: string;
  timeoutMs: number;
  /** Only tests replace the global `fetch` and the log. */
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
};

const redirectLogged = new Set<string>();

export async function checkOrgMembership({
  apiBaseUrl,
  org,
  accessToken,
  timeoutMs,
  fetchImpl = fetch,
  log = console.error,
}: CheckOrgMembershipOptions): Promise<OrgMembership> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(org)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "code-reviewer",
        },
        // Never follow a redirect: it would carry the token to another address.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    return "unavailable";
  }

  // A redirect means the organization was renamed or moved: the configured name is stale.
  if (response.status >= 300 && response.status < 400) {
    if (!redirectLogged.has(org)) {
      redirectLogged.add(org);
      log(
        "[auth] ORG_CHECK_REDIRECTED: GitHub redirected the organization membership check. ALLOWED_GITHUB_ORG probably names an organization that was renamed or moved; set it to the current name.",
      );
    }
    return "unavailable";
  }
  if (response.status === 401) return "token_invalid";
  if (
    (response.status === 403 || response.status === 404) &&
    lacksOrgScope(response)
  )
    return "token_invalid";
  if (response.status === 404) return "not_member";
  if (response.status !== 200) return "unavailable";

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "unavailable";
  }
  return membershipFromBody(body, org);
}

function membershipFromBody(body: unknown, org: string): OrgMembership {
  if (typeof body !== "object" || body === null) return "unavailable";
  const { state, organization } = body as {
    state?: unknown;
    organization?: { login?: unknown } | null;
  };
  const login = organization?.login;
  if (typeof login !== "string" || login.toLowerCase() !== org.toLowerCase())
    return "unavailable";
  if (state === "active") return "member";
  if (state === "pending") return "not_member";
  return "unavailable";
}

// Only a header that is there and lacks the scopes counts; an answer without the header (a fake, a
// proxy) says nothing about the scope.
function lacksOrgScope(response: Response): boolean {
  const header = response.headers.get("x-oauth-scopes");
  if (header === null) return false;
  const granted = header.split(/[ ,]+/).filter(Boolean);
  return !ORG_SCOPES.some((scope) => granted.includes(scope));
}

/**
 * A membership check with the address, organization and timeout fixed: the one function that the
 * sign in and the request check both call, so they cannot drift apart.
 */
export function membershipChecker(
  options: Omit<CheckOrgMembershipOptions, "accessToken" | "timeoutMs"> & {
    timeoutMs?: number;
  },
): (accessToken: string) => Promise<OrgMembership> {
  const { timeoutMs = ORG_CHECK_TIMEOUT_MS, ...rest } = options;
  return (accessToken) =>
    checkOrgMembership({ ...rest, accessToken, timeoutMs });
}
