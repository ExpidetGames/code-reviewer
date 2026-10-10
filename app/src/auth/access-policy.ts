// "Who may use this instance", decided on every authenticated request. Both places that grant access
// go through it: the proxy (every request) and `requireUser` (every page or action that needs the
// user), via `lookupSession`.
//
// The rule (config in `access-config.ts`): a login on `ALLOWED_GITHUB_LOGINS` is allowed, checked on
// every request, so removing a login takes effect at once, but only for the GitHub account the login
// is bound to (`login-pins.ts`): the same login on another account is an impostor, who is turned away
// and signed out. Otherwise, with `ALLOWED_GITHUB_ORG` set,
// the person must be a member of that organization; that costs a call to GitHub, so a yes is
// remembered on the user (`orgCheckedAt` for `orgCheckedFor`) and asked again every 24 hours, or at
// once when the configured organization is another one than the one that was checked. With neither
// set nobody is allowed. Anything that cannot be decided is a no.
import { isLoginListed, type AccessConfig } from "./access-config.ts";
import { deny, type AccessDecision } from "./access-decision.ts";
import type { OrgMembership } from "./github-org.ts";
import { checkLoginPin, type LoginPins } from "./login-pins.ts";

export type {
  AccessDecision,
  AccessDenialReason,
  AccessDenied,
} from "./access-decision.ts";

/** The part of the signed in user that an access rule may look at. */
export type SessionUser = {
  id: string;
  name: string;
  /** The current GitHub login (refreshed at every sign in). */
  githubLogin: string;
  /** The stable numeric GitHub id of the account (from its `accounts` row), as text. */
  githubId: string;
  /** ISO 8601 time of the last successful organization check, or null when there was none. */
  orgCheckedAt: string | null;
  /** The organization that check was made for, or null. */
  orgCheckedFor: string | null;
};

/**
 * Decides whether a signed in user may use the app. It runs on every authenticated request. A
 * denial is treated like a request without a session, and the reason is shown on the login page.
 */
export type AccessPolicy = (user: SessionUser) => Promise<AccessDecision>;

/** How long a successful organization check is trusted. */
export const ORG_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long a user is turned away without asking GitHub again after a check that could not be made. */
export const ORG_UNAVAILABLE_BACKOFF_MS = 20 * 1000;

/** What the organization rule needs from the outside world. */
export type OrgAccessDependencies = {
  /** Asks GitHub with the user's stored token. */
  checkMembership: (user: SessionUser) => Promise<OrgMembership>;
  /** Stores the time of a successful check, and the organization it was made for, on the user. */
  recordCheck: (userId: string, at: Date, org: string) => Promise<void>;
  /** Ends every session of the user (they have lost access, or must sign in again). */
  revokeSessions: (userId: string) => Promise<void>;
};

/** What the rule for listed logins needs from the outside world. */
export type LoginPinDependencies = LoginPins & {
  /** Ends every session of the user (somebody else's account that carries a listed login). */
  revokeSessions: (userId: string) => Promise<void>;
};

export type CreateAccessPolicyOptions = {
  config: AccessConfig;
  /** Where listed logins are bound to a GitHub id. Never called for a login that is not listed. */
  loginPins: LoginPinDependencies;
  /** Needed when `config.org` is set. Never called otherwise. */
  org?: OrgAccessDependencies;
  now?: () => Date;
  /** Where a failed write is reported (no user data, no token). */
  logError?: (message: string) => void;
};

const ALLOWED: AccessDecision = { allowed: true };

export function createAccessPolicy({
  config,
  loginPins,
  org,
  now = () => new Date(),
  logError = console.error,
}: CreateAccessPolicyOptions): AccessPolicy {
  // Requests of one user that arrive together share one call to GitHub.
  const inFlight = new Map<string, Promise<AccessDecision>>();
  // Users whose last check could not be made, and until when they are turned away without a call:
  // during an outage or a rate limit every page load would otherwise hit GitHub again.
  const backoffUntil = new Map<string, number>();

  async function revoke(
    userId: string,
    revokeSessions: ((userId: string) => Promise<void>) | undefined,
  ): Promise<void> {
    try {
      await revokeSessions?.(userId);
    } catch {
      // The person is turned away either way; the sessions are refused on every request anyway.
      logError(
        "[auth] ACCESS_REVOKE_FAILED: could not end the sessions of a user",
      );
    }
  }

  async function decideByOrganization(
    user: SessionUser,
    orgName: string,
    deps: OrgAccessDependencies,
  ): Promise<AccessDecision> {
    const current = now();
    if (isFresh(user, orgName, current)) return ALLOWED;

    const blockedUntil = backoffUntil.get(user.id);
    if (blockedUntil !== undefined) {
      if (current.getTime() < blockedUntil) return deny("check_failed");
      backoffUntil.delete(user.id);
    }

    let membership: OrgMembership;
    try {
      membership = await deps.checkMembership(user);
    } catch {
      membership = "unavailable";
    }
    switch (membership) {
      case "member":
        try {
          await deps.recordCheck(user.id, current, orgName);
        } catch {
          logError(
            "[auth] ORG_ACCESS_RECORD_FAILED: could not store an organization check",
          );
          return deny("check_failed");
        }
        return ALLOWED;
      case "not_member":
        await revoke(user.id, deps.revokeSessions);
        return deny("not_allowed");
      case "token_invalid":
        await revoke(user.id, deps.revokeSessions);
        return deny("sign_in_again");
      case "unavailable":
        backoffUntil.set(
          user.id,
          current.getTime() + ORG_UNAVAILABLE_BACKOFF_MS,
        );
        return deny("check_failed");
    }
  }

  return async function accessPolicy(user): Promise<AccessDecision> {
    let listed: "none" | "mismatch" | "unavailable" = "none";
    if (isLoginListed(config, user.githubLogin)) {
      // The first request of an account that has no pin yet binds the login to it.
      const pin = await checkLoginPin(
        loginPins,
        user.githubLogin,
        user.githubId,
      );
      if (pin === "match") return ALLOWED;
      listed = pin;
    }
    if (config.org === null || org === undefined) {
      if (listed === "unavailable") return deny("check_failed");
      // The login is listed but belongs to another account: this one is not who the list means,
      // and must not keep a session.
      if (listed === "mismatch")
        await revoke(user.id, loginPins.revokeSessions);
      return deny("not_allowed");
    }

    const running = inFlight.get(user.id);
    if (running) return running;
    const decision = decideByOrganization(user, config.org, org).finally(() => {
      inFlight.delete(user.id);
    });
    inFlight.set(user.id, decision);
    return decision;
  };
}

function isFresh(user: SessionUser, orgName: string, current: Date): boolean {
  // A check made for another organization says nothing about this one.
  if (user.orgCheckedFor?.toLowerCase() !== orgName.toLowerCase()) return false;
  if (user.orgCheckedAt === null) return false;
  const checked = Date.parse(user.orgCheckedAt);
  if (Number.isNaN(checked)) return false;
  const age = current.getTime() - checked;
  // A time in the future is not trusted (a clock that went back, or a tampered row).
  return age >= 0 && age < ORG_RECHECK_INTERVAL_MS;
}
