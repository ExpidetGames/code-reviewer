// The decision made while a sign in is completed, before any user, account or session is written.
// It is made from the profile and the freshly issued token, so a person who is not allowed leaves
// nothing behind. The decision travels from the GitHub provider (which has the token) to Better
// Auth's `validateUserInfo` gate (which can refuse) inside the profile, see `github-provider.ts`.
import { isLoginListed, type AccessConfig } from "./access-config.ts";
import {
  deny,
  isAccessDenialReason,
  type AccessDenied,
} from "./access-decision.ts";
import type { OrgMembership } from "./github-org.ts";

/** A confirmed membership, to be stored on the user. */
export type OrgCheckRecord = {
  /** ISO 8601 time of the check. */
  at: string;
  /** The organization it was made for. */
  org: string;
};

export type SignInAccess =
  | {
      allowed: true;
      /** Set when the organization membership was confirmed; null if the login list sufficed. */
      orgCheck: OrgCheckRecord | null;
    }
  | AccessDenied;

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
  if (isLoginListed(config, login)) return { allowed: true, orgCheck: null };
  if (config.org === null) return deny("not_allowed");

  let membership: OrgMembership;
  try {
    membership = await checkMembership();
  } catch {
    return deny("check_failed");
  }
  switch (membership) {
    case "member":
      return {
        allowed: true,
        orgCheck: { at: now().toISOString(), org: config.org },
      };
    case "not_member":
      return deny("not_allowed");
    case "token_invalid":
    case "unavailable":
      return deny("check_failed");
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
  if (typeof access !== "object" || access === null) return deny("not_allowed");
  const { allowed, orgCheck, reason } = access as Record<string, unknown>;
  if (allowed === true)
    return { allowed: true, orgCheck: readOrgCheck(orgCheck) };
  return deny(isAccessDenialReason(reason) ? reason : "not_allowed");
}

function readOrgCheck(value: unknown): OrgCheckRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { at, org } = value as Record<string, unknown>;
  return typeof at === "string" && typeof org === "string" ? { at, org } : null;
}
