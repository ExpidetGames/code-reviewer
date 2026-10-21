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
// read the accounts of the bound installations; take the balance lock (the journal's rule: the lock before any write); take the
// first bound account nobody was granted yet (an insert that the primary key lets exactly one writer win, so two workspaces of
// one account meeting billing at the same moment get one grant between them, on Postgres and SQLite); write the entry. If
// anything fails the row is not there either, and the next contact tries again. Nothing is ever granted a second time by
// retrying, because every step is keyed.
//
// The grant never fails its caller (the claim of a job runs it): it runs inside a savepoint, and an error of any kind (a damaged
// row, a database error) rolls back to it, is logged under a stable code without the error text, and ends as `failed`. The
// workspace is then judged on its balance as usual, and the next contact tries again. A savepoint, not a catch alone: a
// Postgres transaction that met an error accepts no statement until it is rolled back to one. What it reads of an installation
// is its `config` and nothing else, and only of a GitHub App that is not disconnected, so a row this code does not understand
// (another type, a damaged credential) cannot stop it.
//
// The `BILLING_START_CREDIT_GRANTED` line is written after the transaction committed: by this function when it opened the
// transaction, and by the caller (`logStartCreditGranted`) when it handed one in.
//
// Billing off: `ensureStartCredit` reads the instance setting and nothing else (no billing table, no integration).
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import {
  createBillingStartCreditGrantsRepository,
  isGithubAccountId,
} from "../db/repositories/billing-start-credit-grants-repository.ts";
import { tryDecodeJson } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import { isBillingOn, readStartCreditMicroUsd } from "./enabled.ts";

/** The key of the one `start_credit` entry of a workspace (with its type and workspace it is the journal's idempotency key). */
export const START_CREDIT_REF_KEY = "start-credit";

/** The stable code of the log line written when a grant is made. */
export const START_CREDIT_LOG_CODE = "BILLING_START_CREDIT_GRANTED";

/** The stable code of the log line written when a grant failed and was skipped; it carries the workspace and never the error. */
export const START_CREDIT_FAILED_LOG_CODE = "BILLING_START_CREDIT_FAILED";

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
  | { status: "billing_off" }
  /** Something failed; it is logged, nothing was written, the next contact tries again. */
  | { status: "failed" };

/**
 * The GitHub accounts a workspace is bound to, from the `config` texts of its installations that are not disconnected, by the
 * numeric id of their account (the installation's `accountId`, #103). A config that is not a JSON object, an installation that
 * does not name an account, or one that names something that is no account id ties the workspace to no account and so earns no
 * credit; none of them is an error.
 */
export function githubAccountsOf(configs: readonly string[]): string[] {
  const accounts: string[] = [];
  for (const text of configs) {
    const decoded = tryDecodeJson<unknown>(text);
    if (!decoded.ok) continue;
    const config = decoded.value;
    if (typeof config !== "object" || config === null) continue;
    const { accountId } = config as { accountId?: unknown };
    const id =
      typeof accountId === "number" && Number.isSafeInteger(accountId)
        ? String(accountId)
        : accountId;
    if (isGithubAccountId(id) && !accounts.includes(id)) accounts.push(id);
  }
  return accounts;
}

/** Reads the `config` of the workspace's GitHub App installations that are not disconnected, and nothing else of them. */
async function boundGithubAccounts(
  trx: Kysely<Database>,
  workspaceId: string,
): Promise<string[]> {
  const rows = await trx
    .selectFrom("integrations")
    .select("config")
    .where("workspace_id", "=", workspaceId)
    .where("type", "=", "github_app")
    .where("status", "<>", "disconnected")
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return githubAccountsOf(rows.map((row) => row.config));
}

const SAVEPOINT = "start_credit_grant";

/** The log line of a grant that was made and committed. */
export function logStartCreditGranted(
  workspaceId: string,
  amountMicroUsd: number,
): void {
  console.info(
    `[billing] ${START_CREDIT_LOG_CODE} workspace=${workspaceId} amountMicroUsd=${String(amountMicroUsd)}`,
  );
}

async function grant(
  trx: Kysely<Database>,
  workspaceId: string,
  now: () => Date,
): Promise<StartCreditResult> {
  const journal = createBillingJournalRepository(trx, workspaceId, now);
  const existing = await journal.findByKey(
    "start_credit",
    START_CREDIT_REF_KEY,
  );
  if (existing !== undefined)
    return { status: "already_granted", entry: existing };

  const startCreditMicroUsd = await readStartCreditMicroUsd(trx);
  if (startCreditMicroUsd === 0) return { status: "disabled" };

  const accounts = await boundGithubAccounts(trx, workspaceId);
  if (accounts.length === 0) return { status: "no_installation" };

  // The journal's rule for every writer: the balance row's lock first, then any write; the grants table is one.
  await journal.lockBalance();
  const grants = createBillingStartCreditGrantsRepository(trx, now);
  for (const account of accounts) {
    const claim = await grants.claim(account, workspaceId);
    if (claim.claimed) {
      const { entry } = await journal.append({
        type: "start_credit",
        amountMicroUsd: startCreditMicroUsd,
        refKey: START_CREDIT_REF_KEY,
      });
      return { status: "granted", entry };
    }
    // The same workspace got it a moment ago, from another request that committed first.
    if (claim.grant.workspaceId === workspaceId) {
      const entry = await journal.findByKey(
        "start_credit",
        START_CREDIT_REF_KEY,
      );
      if (entry !== undefined) return { status: "already_granted", entry };
    }
  }
  return { status: "account_already_granted" };
}

/** `grant` inside a savepoint: whatever goes wrong inside it is undone, logged and answered as `failed`, never thrown. */
async function grantOrSkip(
  trx: Kysely<Database>,
  workspaceId: string,
  now: () => Date,
): Promise<StartCreditResult> {
  await sql.raw(`savepoint ${SAVEPOINT}`).execute(trx);
  try {
    const result = await grant(trx, workspaceId, now);
    await sql.raw(`release savepoint ${SAVEPOINT}`).execute(trx);
    return result;
  } catch {
    await sql.raw(`rollback to savepoint ${SAVEPOINT}`).execute(trx);
    console.warn(
      `[billing] ${START_CREDIT_FAILED_LOG_CODE} workspace=${workspaceId} the start credit was skipped`,
    );
    return { status: "failed" };
  }
}

/**
 * The grant, for a caller that has already established that billing is on (the claim reads the switch once for its
 * whole batch). Everything else asks `ensureStartCredit`. Never throws for a failed grant: the result says `failed`. When the
 * caller hands in a transaction, the caller logs a `granted` result after its commit (`logStartCreditGranted`); otherwise
 * this function does.
 */
export async function ensureStartCreditWhileOn(
  db: Kysely<Database>,
  workspaceId: string,
  now: () => Date = () => new Date(),
): Promise<StartCreditResult> {
  if (db.isTransaction) return grantOrSkip(db, workspaceId, now);
  const result = await db
    .transaction()
    .execute((trx) => grantOrSkip(trx, workspaceId, now));
  if (result.status === "granted")
    logStartCreditGranted(workspaceId, result.entry.amountMicroUsd);
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
