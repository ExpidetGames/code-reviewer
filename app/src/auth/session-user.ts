// SPDX-License-Identifier: Apache-2.0

// Reading the signed in user from request headers: asks Better Auth (which checks the session row
// and its expiry in the database) and then the access policy. The proxy and the pages both use it,
// so the answer is the same everywhere.
import type {
  AccessDenialReason,
  AccessPolicy,
  GithubSessionUser,
  SessionUser,
} from "./access-policy.ts";
import type { AccessGates } from "./access-gates.ts";
import type { Auth } from "./auth.ts";
import { GITHUB_PROVIDER_ID } from "./github-provider.ts";

/** The `accounts.provider_id` Better Auth gives an email and password identity. */
export const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * - `user`: a valid session of a user who may use the app.
 * - `unverified`: a valid session of an email and password account whose address must be verified
 *   first (a mail server is configured). Only the instance admin may still use `/admin`.
 * - `no_workspace`: a valid session of an email and password account that belongs to no workspace, so
 *   it has no access to customer data (access-gates.ts).
 * - `none`: no valid session.
 * - `denied`: a valid session of a user who may not (any more) use the app; the reason is shown on
 *   the login page.
 */
export type SessionLookup =
  | { kind: "user"; user: SessionUser }
  | { kind: "unverified"; user: SessionUser }
  | { kind: "no_workspace"; user: SessionUser }
  | { kind: "none" }
  | { kind: "denied"; reason: AccessDenialReason };

export async function lookupSession(
  auth: Pick<Auth, "api" | "$context">,
  requestHeaders: Headers,
  policy: AccessPolicy,
  gates: AccessGates,
): Promise<SessionLookup> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { kind: "none" };
  const identities = await findIdentities(auth, session.user.id);
  // The stable identity of a GitHub account is the id GitHub gave it, kept in `accounts.account_id`.
  // The login can change; this cannot. A user with no identity at all cannot sign in.
  if (!identities.password && identities.githubId === null)
    return { kind: "none" };
  const githubLogin = session.user.githubLogin || null;
  const user: SessionUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    isInstanceAdmin: session.user.isInstanceAdmin === true,
    githubLogin,
    githubId: identities.githubId,
    image: session.user.image ?? null,
    orgCheckedAt: session.user.orgCheckedAt ?? null,
    orgCheckedFor: session.user.orgCheckedFor ?? null,
  };
  // An account with a password is admitted: such an account only exists because the first-run setup
  // made it, or because the sign-up rule let it be created (src/signup/sign-up.ts evaluates that rule
  // when the account is created, not on every request, so a stricter rule never locks anybody out). The
  // GitHub allow list is about GitHub identities. Two gates stand in front of the app, though: a
  // verified address, and a workspace (access-gates.ts).
  if (identities.password) {
    if (!session.user.emailVerified && (await gates.verificationRequired()))
      return { kind: "unverified", user };
    if (!user.isInstanceAdmin && !(await gates.hasWorkspace(user.id)))
      return { kind: "no_workspace", user };
    return { kind: "user", user };
  }
  if (githubLogin === null || identities.githubId === null)
    return { kind: "none" };
  const decision = await policy({
    ...user,
    githubLogin,
    githubId: identities.githubId,
  } satisfies GithubSessionUser);
  return decision.allowed
    ? { kind: "user", user }
    : { kind: "denied", reason: decision.reason };
}

async function findIdentities(
  auth: Pick<Auth, "$context">,
  userId: string,
): Promise<{ password: boolean; githubId: string | null }> {
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(userId);
  const github = accounts.find(
    (candidate) => candidate.providerId === GITHUB_PROVIDER_ID,
  );
  return {
    password: accounts.some(
      (candidate) =>
        candidate.providerId === CREDENTIAL_PROVIDER_ID &&
        Boolean(candidate.password),
    ),
    githubId: github?.accountId ? github.accountId : null,
  };
}

/** The address of the page that explains why a signed in person cannot use the app yet. */
export const VERIFY_EMAIL_PAGE = "/verify-email";
export const NO_ACCESS_PAGE = "/no-access";

/** Where a request that cannot be served goes: the login page, or the page that says what is missing. */
export function loginPath(lookup: SessionLookup): string {
  switch (lookup.kind) {
    case "denied":
      return `/login?error=${lookup.reason}`;
    case "unverified":
      return VERIFY_EMAIL_PAGE;
    case "no_workspace":
      return NO_ACCESS_PAGE;
    default:
      return "/login";
  }
}
