// SPDX-License-Identifier: Apache-2.0

// The memory of the start credit (table `billing_start_credit_grants`; ADR 0006, 2.16, D11; #507): which GitHub accounts were
// granted it and for which workspace. INSTANCE LEVEL, on purpose (src/db/repositories/scoping.test.ts): the credit is tied to
// the GitHub account of an installation, which no workspace owns, so "was this account granted before" has to be asked across
// workspaces, and the row has to outlive the workspace it names. It holds a numeric id, a workspace id and a time: not customer
// data. The one write is `claim`, and it is the lock of the whole grant: the primary key lets exactly one of two writers insert
// an account, whatever their transactions do (Postgres makes the second wait for the first to commit; SQLite has one writer).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

/** A GitHub account id as the table stores it: GitHub's number as plain text, no sign, no leading zero. */
const ACCOUNT_ID = /^[1-9][0-9]{0,18}$/;

export function isGithubAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID.test(value);
}

export type StartCreditGrant = {
  githubAccountId: string;
  workspaceId: string;
  /** ISO 8601 text in UTC. */
  grantedAt: string;
};

export type StartCreditClaim =
  /** This call wrote the row: the account is now granted for this workspace. */
  | { claimed: true }
  /** The account was granted before, to this or another workspace (which may be gone). */
  | { claimed: false; grant: StartCreditGrant };

export type BillingStartCreditGrantsRepository = {
  /**
   * Records that the account is granted, for the workspace, unless it already is. Call it inside the transaction that writes the
   * `start_credit` entry: when that transaction does not commit, neither does the row. A repeated or racing call for an account
   * gets `claimed: false` and the row that exists.
   */
  claim(
    githubAccountId: string,
    workspaceId: string,
  ): Promise<StartCreditClaim>;
  find(githubAccountId: string): Promise<StartCreditGrant | undefined>;
};

export function createBillingStartCreditGrantsRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): BillingStartCreditGrantsRepository {
  async function find(githubAccountId: string) {
    const row = await db
      .selectFrom("billing_start_credit_grants")
      .selectAll()
      .where("github_account_id", "=", githubAccountId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          githubAccountId: row.github_account_id,
          workspaceId: row.workspace_id,
          grantedAt: row.granted_at,
        };
  }

  async function claim(
    githubAccountId: string,
    workspaceId: string,
  ): Promise<StartCreditClaim> {
    if (!isGithubAccountId(githubAccountId))
      throw new TypeError("A GitHub account id is a positive number.");
    const inserted = await db
      .insertInto("billing_start_credit_grants")
      .values({
        github_account_id: githubAccountId,
        workspace_id: workspaceId,
        granted_at: formatTimestamp(now()),
      })
      .onConflict((conflict) =>
        conflict.column("github_account_id").doNothing(),
      )
      .returning("github_account_id")
      .executeTakeFirst();
    if (inserted !== undefined) return { claimed: true };
    const grant = await find(githubAccountId);
    // The app never deletes a row; if a person removed it between the two statements, the account is free again.
    if (grant === undefined) return claim(githubAccountId, workspaceId);
    return { claimed: false, grant };
  }

  return { find, claim };
}
