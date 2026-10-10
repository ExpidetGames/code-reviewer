// The decision made while a sign in is completed, before any user, account or session is written.
// It is made from the profile and the freshly issued token, so a person who is not allowed leaves
// nothing behind. The decision travels from the GitHub provider (which has the token) to Better
// Auth's `validateUserInfo` gate (which can refuse) inside the profile, see `github-provider.ts`.
import { isLoginListed, type AccessConfig } from "./access-config.ts";
import type { OrgMembership } from "./github-org.ts";

export type SignInAccess =
  | {
      allowed: true;
      /** When the organization membership was confirmed, or null if the login list sufficed. */
      orgCheckedAt: string | null;
    }
  | { allowed: false; reason: "not_allowed" | "check_failed" };

export type DecideSignInOptions = {
  config: AccessConfig;
  login: string;
  /** Asks GitHub whether the person is in the organization. Called only in organization mode. */
  checkMembership: () => Promise<OrgMembership>;
  now?: () => Date;
};

export async function decideSignIn({
  config,
  login,
  checkMembership,
  now = () => new Date(),
}: DecideSignInOptions): Promise<SignInAccess> {
  if (isLoginListed(config, login))
    return { allowed: true, orgCheckedAt: null };
  if (config.org === null) return { allowed: false, reason: "not_allowed" };

  let membership: OrgMembership;
  try {
    membership = await checkMembership();
  } catch {
    return { allowed: false, reason: "check_failed" };
  }
  switch (membership) {
    case "member":
      return { allowed: true, orgCheckedAt: now().toISOString() };
    case "not_member":
      return { allowed: false, reason: "not_allowed" };
    case "token_invalid":
    case "unavailable":
      return { allowed: false, reason: "check_failed" };
  }
}

/**
 * Reads the decision back out of the profile that the provider returned. Anything that is not
 * exactly a decision (missing, wrong shape) counts as not allowed.
 */
export function readSignInAccess(
  profile: Record<string, unknown> | undefined,
): SignInAccess {
  const access = profile?.codeReviewerAccess;
  if (typeof access !== "object" || access === null)
    return { allowed: false, reason: "not_allowed" };
  const { allowed, orgCheckedAt, reason } = access as Record<string, unknown>;
  if (allowed === true)
    return {
      allowed: true,
      orgCheckedAt: typeof orgCheckedAt === "string" ? orgCheckedAt : null,
    };
  return {
    allowed: false,
    reason: reason === "check_failed" ? "check_failed" : "not_allowed",
  };
}
