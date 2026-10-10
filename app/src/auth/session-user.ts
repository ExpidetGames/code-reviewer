// Reading the signed in user from request headers: asks Better Auth (which checks the session row
// and its expiry in the database) and then the access policy. The proxy and the pages both use it,
// so the answer is the same everywhere.
import type {
  AccessDenialReason,
  AccessPolicy,
  SessionUser,
} from "./access-policy.ts";
import type { Auth } from "./auth.ts";
import { GITHUB_PROVIDER_ID } from "./github-provider.ts";

/**
 * - `user`: a valid session of a user who may use the app.
 * - `none`: no valid session.
 * - `denied`: a valid session of a user who may not (any more) use the app; the reason is shown on
 *   the login page.
 */
export type SessionLookup =
  | { kind: "user"; user: SessionUser }
  | { kind: "none" }
  | { kind: "denied"; reason: AccessDenialReason };

export async function lookupSession(
  auth: Pick<Auth, "api" | "$context">,
  requestHeaders: Headers,
  policy: AccessPolicy,
): Promise<SessionLookup> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { kind: "none" };
  // The stable identity of the account: the id GitHub gave it, kept in `accounts.account_id`. The
  // login can change; this cannot. A user without a GitHub account cannot exist (GitHub is the only
  // way in), so such a session is treated as no session at all.
  const githubId = await findGithubId(auth, session.user.id);
  if (githubId === null) return { kind: "none" };
  const user: SessionUser = {
    id: session.user.id,
    name: session.user.name,
    githubLogin: session.user.githubLogin,
    githubId,
    image: session.user.image ?? null,
    orgCheckedAt: session.user.orgCheckedAt ?? null,
    orgCheckedFor: session.user.orgCheckedFor ?? null,
  };
  const decision = await policy(user);
  return decision.allowed
    ? { kind: "user", user }
    : { kind: "denied", reason: decision.reason };
}

async function findGithubId(
  auth: Pick<Auth, "$context">,
  userId: string,
): Promise<string | null> {
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(userId);
  const account = accounts.find(
    (candidate) => candidate.providerId === GITHUB_PROVIDER_ID,
  );
  return account?.accountId ? account.accountId : null;
}

/** The login page address for a request that has no usable session. */
export function loginPath(lookup: SessionLookup): string {
  return lookup.kind === "denied" ? `/login?error=${lookup.reason}` : "/login";
}
