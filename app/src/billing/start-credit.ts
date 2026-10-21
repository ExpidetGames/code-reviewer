// SPDX-License-Identifier: Apache-2.0

// The start credit (ADR 0006, 2.16, D11, P7; #507): a `start_credit` journal entry of the amount the admin set (0 disables
// it), granted ONCE PER GITHUB ACCOUNT, lazily, the first time a workspace with a bound installation meets billing while
// billing is on. The first claim of a job (src/db/repositories/runner-jobs-repository.ts) and the first visit of the billing page
// both call the one function here, so there is one rule and no scheduler.
//
// Why the account and not the workspace: a workspace costs nothing to create, a GitHub account that installs the App is the
// cheapest thing a farmer cannot mint without GitHub noticing. The memory is the instance table `billing_start_credit_grants`
// (primary key: the numeric account id; no foreign key to a workspace), so deleting a workspace and creating it again, or binding
// a second workspace to the same account, finds the account already granted. A workspace gets at most one grant, whatever
// number of installations it binds: the journal key `(workspace, start_credit, "start-credit")` says so.
//
// One transaction does all of it (the claim's, when the caller hands one in): look for the workspace's entry; read the amount;
// take the first bound account nobody was granted yet (an insert that the primary key lets exactly one writer win, so two
// workspaces of one account meeting billing at the same moment get one grant between them, on Postgres and SQLite); write the
// entry. If anything fails the row is not there either, and the next contact tries again. Nothing is ever granted a second time
// by retrying, because every step is keyed.
//
// Billing off: `ensureStartCredit` reads the instance setting and nothing else (no billing table, no integration).
import "server-only";
import type { Kysely } from "kysely";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import {
  createBillingStartCreditGrantsRepository,
  isGithubAccountId,
} from "../db/repositories/billing-start-credit-grants-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { Database } from "../db/schema.ts";
import type { Integration } from "../integrations/types.ts";
import { isBillingOn, readStartCreditMicroUsd } from "./enabled.ts";

/** The key of the one `start_credit` entry of a workspace (with its type and workspace it is the journal's idempotency key). */
export const START_CREDIT_REF_KEY = "start-credit";

/** The stable code of the log line written when a grant is made. */
export const START_CREDIT_LOG_CODE = "BILLING_START_CREDIT_GRANTED";

export type StartCreditResult =
  /** This call wrote the entry. */
  | { status: "granted"; entry: JournalEntry }
  /** The workspace has its entry already. */
  | { status: "already_granted"; entry: JournalEntry }
  /** Every GitHub account the workspace is bound to was granted before (to another workspace, or to one that is gone). */
  | { status: "account_already_granted" }
  /** The workspace has no installation that names a GitHub account. */
  | { status: "no_installation" }
  /** The amount is 0. */
  | { status: "disabled" }
  | { status: "billing_off" };

/**
 * The GitHub accounts a workspace is bound to: the installations that are not disconnected, by the numeric id of their
 * account (the installation's `accountId`, #103). An installation that does not name one, or names something that is no
 * account id, ties the workspace to no account and so earns no credit.
 */
export function githubAccountsOf(integrations: Integration[]): string[] {
  const accounts: string[] = [];
  for (const integration of integrations) {
    if (integration.type !== "github_app") continue;
    if (integration.status === "disconnected") continue;
    const { accountId } = integration.config;
    const id =
      typeof accountId === "number" && Number.isSafeInteger(accountId)
        ? String(accountId)
        : accountId;
    if (isGithubAccountId(id) && !accounts.includes(id)) accounts.push(id);
  }
  return accounts;
}

function inTransaction<T>(
  db: Kysely<Database>,
  run: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

/**
 * The grant, for a caller that has already established that billing is on (the claim reads the switch once for its
 * whole batch). Everything else asks `ensureStartCredit`.
 */
export async function ensureStartCreditWhileOn(
  db: Kysely<Database>,
  workspaceId: string,
  now: () => Date = () => new Date(),
): Promise<StartCreditResult> {
  const result = await inTransaction(db, async (trx) => {
    const journal = createBillingJournalRepository(trx, workspaceId, now);
    const existing = await journal.findByKey(
      "start_credit",
      START_CREDIT_REF_KEY,
    );
    if (existing !== undefined)
      return { status: "already_granted", entry: existing } as const;

    const startCreditMicroUsd = await readStartCreditMicroUsd(trx);
    if (startCreditMicroUsd === 0) return { status: "disabled" } as const;

    const accounts = githubAccountsOf(
      await createIntegrationsRepository(trx, workspaceId, now).list(),
    );
    if (accounts.length === 0) return { status: "no_installation" } as const;

    const grants = createBillingStartCreditGrantsRepository(trx, now);
    for (const account of accounts) {
      const claim = await grants.claim(account, workspaceId);
      if (claim.claimed) {
        const { entry } = await journal.append({
          type: "start_credit",
          amountMicroUsd: startCreditMicroUsd,
          refKey: START_CREDIT_REF_KEY,
        });
        return { status: "granted", entry } as const;
      }
      // The same workspace got it a moment ago, from another request that committed first.
      if (claim.grant.workspaceId === workspaceId) {
        const entry = await journal.findByKey(
          "start_credit",
          START_CREDIT_REF_KEY,
        );
        if (entry !== undefined)
          return { status: "already_granted", entry } as const;
      }
    }
    return { status: "account_already_granted" } as const;
  });
  if (result.status === "granted")
    console.info(
      `[billing] ${START_CREDIT_LOG_CODE} workspace=${workspaceId} amountMicroUsd=${String(result.entry.amountMicroUsd)}`,
    );
  return result;
}

/** The one function of the start credit: grants it if billing is on and it is due, and says what it did. Idempotent and race safe. */
export async function ensureStartCredit(
  db: Kysely<Database>,
  workspaceId: string,
  now: () => Date = () => new Date(),
): Promise<StartCreditResult> {
  if (!(await isBillingOn(db))) return { status: "billing_off" };
  return ensureStartCreditWhileOn(db, workspaceId, now);
}
