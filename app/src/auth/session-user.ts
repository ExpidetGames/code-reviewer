// Reading the signed in user from request headers: asks Better Auth (which checks the session row
// and its expiry in the database) and then the access policy. The proxy and the pages both use it,
// so the answer is the same everywhere.
import {
  accessPolicy,
  type AccessPolicy,
  type SessionUser,
} from "./access-policy.ts";
import type { Auth } from "./auth.ts";

export async function getSessionUser(
  auth: Pick<Auth, "api">,
  requestHeaders: Headers,
  policy: AccessPolicy = accessPolicy,
): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const user: SessionUser = {
    id: session.user.id,
    name: session.user.name,
    githubLogin: session.user.githubLogin,
  };
  return (await policy(user)) ? user : null;
}
