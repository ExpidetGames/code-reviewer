// Asks GitHub whether the signed in account is a member of the allowed organization. It uses the
// account's own token on `GET /user/memberships/orgs/{org}`, which needs the `read:org` scope and
// also sees private memberships (the public members list would not).
//
// The answer is one of four values. Only a clear yes is "member". A clear no is "not_member". A
// token GitHub no longer accepts is "token_invalid". Everything else (missing scope or rate limit
// as 403, an outage, a malformed body, a timeout) is "unavailable": the caller must treat that as a
// no, but it is not proof that the person left the organization.
//
// The token is only sent in the Authorization header; it never appears in an error or a log line.

export type OrgMembership =
  "member" | "not_member" | "token_invalid" | "unavailable";

export type CheckOrgMembershipOptions = {
  /** Base URL of the GitHub API, without a trailing slash. */
  apiBaseUrl: string;
  org: string;
  accessToken: string;
  timeoutMs: number;
  /** Only tests replace the global `fetch`. */
  fetchImpl?: typeof fetch;
};

export async function checkOrgMembership({
  apiBaseUrl,
  org,
  accessToken,
  timeoutMs,
  fetchImpl = fetch,
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
        // A redirect would carry the token to another address.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    return "unavailable";
  }

  if (response.status === 404) return "not_member";
  if (response.status === 401) return "token_invalid";
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
