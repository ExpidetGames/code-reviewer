// "Who may use this instance", decided on every authenticated request. Both places that grant access
// go through it: the proxy (every request) and `requireUser` (every page or action that needs the
// user), via `getSessionUser`.
//
// The rule (config in `access-config.ts`): a login on `ALLOWED_GITHUB_LOGINS` is allowed, checked on
// every request, so removing a login takes effect at once. Otherwise, with `ALLOWED_GITHUB_ORG` set,
// the person must be a member of that organization; that costs a call to GitHub, so a yes is
// remembered on the user (`orgCheckedAt`) and asked again every 24 hours. With neither set nobody is
// allowed. Anything that cannot be decided is a no.
import { isLoginListed, type AccessConfig } from "./access-config.ts";
import type { OrgMembership } from "./github-org.ts";

/** The part of the signed in user that an access rule may look at. */
export type SessionUser = {
  id: string;
  name: string;
  /** The current GitHub login (refreshed at every sign in). */
  githubLogin: string;
  /** ISO 8601 time of the last successful organization check, or null when there was none. */
  orgCheckedAt: string | null;
};

/**
 * Why a request was turned away. The login page translates the code to copy.
 * - `not_allowed`: the account is not on the list and not in the organization.
 * - `check_failed`: the organization check could not be made (GitHub unreachable, missing scope).
 * - `sign_in_again`: the stored GitHub token no longer works; a new sign in replaces it.
 */
export const ACCESS_DENIAL_REASONS = [
  "not_allowed",
  "check_failed",
  "sign_in_again",
] as const;
export type AccessDenialReason = (typeof ACCESS_DENIAL_REASONS)[number];

export type AccessDecision =
  { allowed: true } | { allowed: false; reason: AccessDenialReason };

/**
 * Decides whether a signed in user may use the app. It runs on every authenticated request. A
 * denial is treated like a request without a session, and the reason is shown on the login page.
 */
export type AccessPolicy = (user: SessionUser) => Promise<AccessDecision>;

/** How long a successful organization check is trusted. */
export const ORG_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What the organization rule needs from the outside world. */
export type OrgAccessDependencies = {
  /** Asks GitHub with the user's stored token. */
  checkMembership: (user: SessionUser) => Promise<OrgMembership>;
  /** Stores the time of a successful check on the user. */
  recordCheck: (userId: string, at: Date) => Promise<void>;
  /** Ends every session of the user (they have lost access, or must sign in again). */
  revokeSessions: (userId: string) => Promise<void>;
};

export type CreateAccessPolicyOptions = {
  config: AccessConfig;
  /** Needed when `config.org` is set. Never called otherwise. */
  org?: OrgAccessDependencies;
  now?: () => Date;
};

const ALLOWED: AccessDecision = { allowed: true };
const deny = (reason: AccessDenialReason): AccessDecision => ({
  allowed: false,
  reason,
});

export function createAccessPolicy({
  config,
  org,
  now = () => new Date(),
}: CreateAccessPolicyOptions): AccessPolicy {
  // Requests of one user that arrive together share one call to GitHub.
  const inFlight = new Map<string, Promise<AccessDecision>>();

  async function decideByOrganization(
    user: SessionUser,
    deps: OrgAccessDependencies,
  ): Promise<AccessDecision> {
    const current = now();
    if (isFresh(user.orgCheckedAt, current)) return ALLOWED;

    let membership: OrgMembership;
    try {
      membership = await deps.checkMembership(user);
    } catch {
      return deny("check_failed");
    }
    switch (membership) {
      case "member":
        await deps.recordCheck(user.id, current);
        return ALLOWED;
      case "not_member":
        await deps.revokeSessions(user.id);
        return deny("not_allowed");
      case "token_invalid":
        await deps.revokeSessions(user.id);
        return deny("sign_in_again");
      case "unavailable":
        return deny("check_failed");
    }
  }

  return async function accessPolicy(user) {
    if (isLoginListed(config, user.githubLogin)) return ALLOWED;
    if (config.org === null || org === undefined) return deny("not_allowed");

    const running = inFlight.get(user.id);
    if (running) return running;
    const decision = decideByOrganization(user, org).finally(() => {
      inFlight.delete(user.id);
    });
    inFlight.set(user.id, decision);
    return decision;
  };
}

function isFresh(checkedAt: string | null, current: Date): boolean {
  if (checkedAt === null) return false;
  const checked = Date.parse(checkedAt);
  if (Number.isNaN(checked)) return false;
  const age = current.getTime() - checked;
  // A time in the future is not trusted (a clock that went back, or a tampered row).
  return age >= 0 && age < ORG_RECHECK_INTERVAL_MS;
}
