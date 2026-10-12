// SPDX-License-Identifier: Apache-2.0

// The one-time notice of the admin portal that the import of an existing installation leaves behind
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.11, point 7): what could not be migrated and
// what the admin has to do about it. Stored as the instance setting `import_notice`, shown on the overview until
// the admin dismisses it. It holds GitHub logins (public names, not secrets), counts and VARIABLE NAMES, never a
// value of a variable.
import type { BlockReason } from "./members.ts";

/** At most this many names are kept in each list; the counts say how many there were. */
export const NOTICE_LIST_LIMIT = 200;

export type NotImportedGroup =
  "github_app" | "llm_key" | "allowed_organization";

export type ImportNotice = {
  /** ISO 8601 time of the import. */
  createdAt: string;
  /** ISO 8601 time the admin dismissed the notice, or null while it is shown. */
  dismissedAt: string | null;
  /** How many users were made members of the default workspace. */
  memberCount: number;
  /** Users who passed the allow list neither by login nor by organization. */
  notMembers: Array<{ login: string | null; reason: BlockReason }>;
  notMembersTotal: number;
  /** Logins on `ALLOWED_GITHUB_LOGINS` that nobody signed in with: invite them by email. */
  neverSignedIn: string[];
  neverSignedInTotal: number;
  /** The allowed GitHub organization, which is NOT migrated into a rule; null when there was none. */
  organization: string | null;
  /** Variables that could not be imported (names only) and why, per part. */
  notImported: Array<{
    group: NotImportedGroup;
    problem: "missing" | "invalid";
    variables: string[];
  }>;
  /** The GitHub OAuth app of the earlier sign in was configured; it is not used any more and not imported. */
  oauthApp: boolean;
  /** Entries of `ALLOWED_GITHUB_LOGINS` that are not valid logins (they admitted nobody). */
  invalidLoginEntries: number;
};

function cap<T>(items: readonly T[]): T[] {
  return items.slice(0, NOTICE_LIST_LIMIT);
}

export function buildImportNotice(input: {
  at: string;
  memberCount: number;
  notMembers: ImportNotice["notMembers"];
  neverSignedIn: string[];
  organization: string | null;
  notImported: ImportNotice["notImported"];
  oauthApp: boolean;
  invalidLoginEntries: number;
}): ImportNotice {
  return {
    createdAt: input.at,
    dismissedAt: null,
    memberCount: input.memberCount,
    notMembers: cap(input.notMembers),
    notMembersTotal: input.notMembers.length,
    neverSignedIn: cap(input.neverSignedIn),
    neverSignedInTotal: input.neverSignedIn.length,
    organization: input.organization,
    notImported: input.notImported,
    oauthApp: input.oauthApp,
    invalidLoginEntries: input.invalidLoginEntries,
  };
}

/** Whether the notice has anything to tell the admin. A clean import leaves no notice. */
export function noticeHasContent(notice: ImportNotice): boolean {
  return (
    notice.notMembersTotal > 0 ||
    notice.neverSignedInTotal > 0 ||
    notice.organization !== null ||
    notice.notImported.length > 0 ||
    notice.oauthApp ||
    notice.invalidLoginEntries > 0
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored notice, or null when the stored value is not one (a row edited by hand counts as no notice). */
export function readImportNotice(value: unknown): ImportNotice | null {
  if (!isObject(value)) return null;
  if (
    typeof value.createdAt !== "string" ||
    typeof value.memberCount !== "number" ||
    !Array.isArray(value.notMembers) ||
    !Array.isArray(value.neverSignedIn) ||
    !Array.isArray(value.notImported)
  )
    return null;
  return value as unknown as ImportNotice;
}
