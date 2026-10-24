// SPDX-License-Identifier: LicenseRef-Proprietary

// Who becomes a member of the default workspace when an existing installation is imported (docs/decisions/
// 0001-editions-setup-and-accounts.md, section 2.11): the users who PASS THE CURRENT ALLOW LIST at import time,
// by the rules the earlier sign in applied on every request:
//
//   - a listed login admits the account the login is bound to: the pin in `allowed_login_pins`, or an id given in
//     the list as `login:id` (which wins over a stored pin, as it did at every start). A login that was never
//     bound is bound to the one account that has it, as the first request of that account would have done.
//     When TWO accounts hold the same unbound login the old rule would have picked whoever came first, which may
//     be a stale row of a renamed account: neither is admitted through the list and both are listed
//     (`login_ambiguous`), and the admin invites the right one. Another account with a bound login is not
//     admitted through the list;
//   - with `ALLOWED_GITHUB_ORG`, a LIVE membership check with the user's own stored GitHub token admits the
//     account as well. Either rule is enough.
//
// A user whose check cannot be completed (no token, a token that cannot be decrypted, GitHub unreachable, a token
// GitHub no longer accepts) is treated as blocked and listed in the notice. The earliest created member becomes
// Owner. Pure apart from the injected membership check; nothing here knows a database or the network.
import { isLoginListed, type AccessConfig } from "../auth/access-config.ts";
import type { OrgMembership } from "../auth/github-org.ts";
import type { LegacyUser } from "../db/repositories/legacy-users-repository.ts";

export const BLOCK_REASONS = [
  /** The login is not on the list and the account is not in the organization (or there is no organization). */
  "not_allowed",
  /** The login is on the list, but bound to another GitHub account. */
  "login_bound_to_another_account",
  /** The login is on the list, not bound to an id, and two accounts of the installation hold it. */
  "login_ambiguous",
  /** The organization check could not be completed: no usable token, or GitHub did not answer. */
  "check_failed",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export type MemberDecision =
  | { userId: string; allowed: true; via: "login" | "organization" }
  | { userId: string; allowed: false; reason: BlockReason };

/** The answer of the check for one user: GitHub's, or why no question could be asked. */
export type OrgCheckOutcome = OrgMembership | "no_token" | "undecryptable";

export type DecideMembersInput = {
  users: readonly LegacyUser[];
  config: AccessConfig;
  /** The ids the logins on the list are bound to (lower case login to id), from `allowed_login_pins`. */
  pins: ReadonlyMap<string, string>;
  /** Asks GitHub with the user's stored token. Called only when an organization is configured. */
  checkOrganization(user: LegacyUser): Promise<OrgCheckOutcome>;
  /** How many checks may run at the same time. */
  concurrency?: number;
};

const DEFAULT_CONCURRENCY = 4;

type ByLogin = { kind: "admitted" } | { kind: "refused"; reason: BlockReason };

/** The list part of the rule. `holders` counts the accounts that hold each unbound listed login. */
function checkList(
  user: LegacyUser,
  config: AccessConfig,
  pins: ReadonlyMap<string, string>,
  holders: ReadonlyMap<string, number>,
): ByLogin {
  if (user.githubLogin === null || user.githubId === null)
    return { kind: "refused", reason: "not_allowed" };
  const login = user.githubLogin.toLowerCase();
  if (!isLoginListed(config, login))
    return { kind: "refused", reason: "not_allowed" };
  // An id given in the list (`login:id`) replaced a stored pin at every start, so it counts first.
  const bound = config.presetIds.get(login) ?? pins.get(login);
  if (bound === undefined)
    return (holders.get(login) ?? 0) > 1
      ? { kind: "refused", reason: "login_ambiguous" }
      : { kind: "admitted" };
  return bound === user.githubId
    ? { kind: "admitted" }
    : { kind: "refused", reason: "login_bound_to_another_account" };
}

async function inPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        await work(item);
      }
    },
  );
  await Promise.all(workers);
}

/** One decision per user, in the order of `users`. */
export async function decideMembers({
  users,
  config,
  pins,
  checkOrganization,
  concurrency = DEFAULT_CONCURRENCY,
}: DecideMembersInput): Promise<MemberDecision[]> {
  const decisions = new Map<string, MemberDecision>();
  const holders = new Map<string, number>();
  for (const user of users) {
    const login = user.githubLogin?.toLowerCase();
    if (login !== undefined) holders.set(login, (holders.get(login) ?? 0) + 1);
  }
  const needOrganization: Array<{ user: LegacyUser; refusal: BlockReason }> =
    [];

  for (const user of users) {
    const byList = checkList(user, config, pins, holders);
    if (byList.kind === "admitted") {
      decisions.set(user.id, { userId: user.id, allowed: true, via: "login" });
      continue;
    }
    if (config.org === null || user.githubId === null) {
      decisions.set(user.id, {
        userId: user.id,
        allowed: false,
        reason: byList.reason,
      });
      continue;
    }
    needOrganization.push({ user, refusal: byList.reason });
  }

  await inPool(needOrganization, concurrency, async ({ user, refusal }) => {
    let outcome: OrgCheckOutcome;
    try {
      outcome = await checkOrganization(user);
    } catch {
      outcome = "unavailable";
    }
    if (outcome === "member")
      decisions.set(user.id, {
        userId: user.id,
        allowed: true,
        via: "organization",
      });
    else if (outcome === "not_member")
      decisions.set(user.id, {
        userId: user.id,
        allowed: false,
        reason: refusal,
      });
    else
      decisions.set(user.id, {
        userId: user.id,
        allowed: false,
        reason: "check_failed",
      });
  });

  return users.map((user) => {
    const decision = decisions.get(user.id);
    if (decision === undefined)
      throw new Error("A user was left without a decision.");
    return decision;
  });
}

/** The earliest created member, who becomes the Owner; null when nobody qualifies. */
export function pickOwner(
  users: readonly LegacyUser[],
  decisions: readonly MemberDecision[],
): string | null {
  const allowed = new Set(
    decisions.filter((decision) => decision.allowed).map((d) => d.userId),
  );
  // `users` is oldest first; the first allowed one is the earliest created.
  return users.find((user) => allowed.has(user.id))?.id ?? null;
}
