// SPDX-License-Identifier: LicenseRef-Proprietary

// The limits on the endpoints of workspaces that can be abused: creating an invitation (which sends a mail
// to an address of the caller's choice), accepting one (which takes a token that can be guessed at, and
// opens the way into a workspace) and creating a workspace. Counted in the shared `rate_limits` table
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.10), through the same module as the
// sign-in and the verification links (src/signup/limits.ts), so every app instance counts the same
// attempts. Every window is at most 24 hours, because the cleanup of old counters relies on it
// (src/maintenance/cleanup.ts, pinned by its test).
//
// - Creating an invitation: per person (30 per hour), per workspace (100 per day), per address that is
//   invited, across workspaces (10 per day, so that nobody can use the app to flood one inbox), and for the
//   whole instance (300 per 10 minutes). The address counter is by a hash of the canonical address, no
//   address is stored. The cheaper counters are asked first, so attempts beyond them use up nothing of
//   the wider ones.
// - Accepting: per person (30 per 10 minutes, whether the token exists or not, so tampered tokens are
//   limited), and per invitation that exists (10 attempts per 24 hours; a token that does not exist touches
//   no such counter, so junk requests can never use up the attempts of a valid link).
// - Creating a workspace: per person (10 per hour).
//
// Not keyed by client address: that is only as trustworthy as the proxy in front of the app.
import { createHash } from "node:crypto";
import { secondsLeft, type SignInPermission } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";

export type Permission = SignInPermission;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const INVITE_PERSON_MAX = 30;
export const INVITE_PERSON_WINDOW_MS = HOUR;
export const INVITE_WORKSPACE_MAX = 100;
export const INVITE_WORKSPACE_WINDOW_MS = DAY;
export const INVITE_ADDRESS_MAX = 10;
export const INVITE_ADDRESS_WINDOW_MS = DAY;
export const INVITE_GLOBAL_MAX = 300;
export const INVITE_GLOBAL_WINDOW_MS = 10 * MINUTE;

export const ACCEPT_PERSON_MAX = 30;
export const ACCEPT_PERSON_WINDOW_MS = 10 * MINUTE;
export const ACCEPT_TOKEN_MAX = 10;
export const ACCEPT_TOKEN_WINDOW_MS = DAY;

export const CREATE_WORKSPACE_PERSON_MAX = 10;
export const CREATE_WORKSPACE_PERSON_WINDOW_MS = HOUR;

/** Every window this module counts, for the test that compares them with the cleanup of old counters. */
export const WORKSPACE_WINDOWS_MS = [
  INVITE_PERSON_WINDOW_MS,
  INVITE_WORKSPACE_WINDOW_MS,
  INVITE_ADDRESS_WINDOW_MS,
  INVITE_GLOBAL_WINDOW_MS,
  ACCEPT_PERSON_WINDOW_MS,
  ACCEPT_TOKEN_WINDOW_MS,
  CREATE_WORKSPACE_PERSON_WINDOW_MS,
] as const;

export type WorkspaceLimits = {
  /** Counts one invitation (and its mail) by this person, in this workspace, to this canonical address. */
  invite(input: {
    userId: string;
    workspaceId: string;
    email: string;
  }): Promise<Permission>;
  /** Counts one attempt to accept, by this person. Asked for every attempt, whatever the token. */
  acceptByPerson(userId: string): Promise<Permission>;
  /** Counts one attempt against an invitation that exists; `tokenHash` is the hash of its token. */
  acceptToken(tokenHash: string): Promise<Permission>;
  /** Counts one creation of a workspace by this person. */
  createWorkspace(userId: string): Promise<Permission>;
};

type Counter = { key: string; max: number; windowMs: number };

function hashed(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const inviteKeys = {
  person: (userId: string) => `invite:user:${hashed(userId)}`,
  workspace: (workspaceId: string) => `invite:workspace:${hashed(workspaceId)}`,
  address: (email: string) => `invite:email:${hashed(email)}`,
  global: "invite:all",
};
export const acceptKeys = {
  person: (userId: string) => `accept-invitation:user:${hashed(userId)}`,
  token: (tokenHash: string) => `accept-invitation:${tokenHash}`,
};
export const createWorkspaceKey = (userId: string) =>
  `create-workspace:user:${hashed(userId)}`;

export function createWorkspaceLimits(
  rateLimits: RateLimitsRepository,
  now: () => Date = () => new Date(),
): WorkspaceLimits {
  /** Asks the counters in order; the first one over its maximum refuses, and the rest are not touched. */
  async function counted(...counters: Counter[]): Promise<Permission> {
    for (const { key, max, windowMs } of counters) {
      const hit = await rateLimits.hit(key, windowMs);
      if (hit.count > max)
        return {
          allowed: false,
          retryAfterSeconds: secondsLeft(hit.windowStartedAt, windowMs, now()),
        };
    }
    return { allowed: true };
  }

  return {
    invite: ({ userId, workspaceId, email }) =>
      counted(
        {
          key: inviteKeys.person(userId),
          max: INVITE_PERSON_MAX,
          windowMs: INVITE_PERSON_WINDOW_MS,
        },
        {
          key: inviteKeys.workspace(workspaceId),
          max: INVITE_WORKSPACE_MAX,
          windowMs: INVITE_WORKSPACE_WINDOW_MS,
        },
        {
          key: inviteKeys.address(email),
          max: INVITE_ADDRESS_MAX,
          windowMs: INVITE_ADDRESS_WINDOW_MS,
        },
        {
          key: inviteKeys.global,
          max: INVITE_GLOBAL_MAX,
          windowMs: INVITE_GLOBAL_WINDOW_MS,
        },
      ),
    acceptByPerson: (userId) =>
      counted({
        key: acceptKeys.person(userId),
        max: ACCEPT_PERSON_MAX,
        windowMs: ACCEPT_PERSON_WINDOW_MS,
      }),
    acceptToken: (tokenHash) =>
      counted({
        key: acceptKeys.token(tokenHash),
        max: ACCEPT_TOKEN_MAX,
        windowMs: ACCEPT_TOKEN_WINDOW_MS,
      }),
    createWorkspace: (userId) =>
      counted({
        key: createWorkspaceKey(userId),
        max: CREATE_WORKSPACE_PERSON_MAX,
        windowMs: CREATE_WORKSPACE_PERSON_WINDOW_MS,
      }),
  };
}
