// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether a workspace has to be told about its balance (ADR 0006, D9; #506). Called inside the transaction of every journal
// write, right after the balance row changed (so the balance row's lock is held: two writers of one workspace never decide at
// the same time), and by a claim that refuses a job for the balance. It writes the state of the two kinds and, when a mail is
// due, marks it; it sends nothing (`balance-mail.ts` sends after the commit), so a failing mail server can neither delay nor
// fail a claim or a settlement, and a transaction that rolls back takes the decision with it.
//
// The rules: a kind is *in its state* while the balance is below the threshold (`low`) or at zero or below (`empty`, which also
// covers a balance below zero). A DROP into a state that was armed marks it `sent` with one mail due; the state stays `sent`
// while the balance stays in it, so ten more settlements mail nothing; a write that finds the balance out of the state arms
// it again, and a mail that was due but not claimed is withdrawn. A CREDIT that lands in a state (a start credit under the
// threshold, a top-up that is still low) marks it `sent` without a mail: the banner and the page already say it, and a mail
// follows the next drop. When one drop is into both states only the more serious mail is due.
//
// With billing off, or switched on but not ready, nothing is read but the switch and nothing is written.
//
// The decision never undoes the money write it follows: callers run it through `noteBalanceMovedSafely` / `guardedBalanceNote`,
// which put it in a savepoint. Anything that goes wrong in it (a table that cannot be written, a damaged row) is rolled back to
// the savepoint, logged as `BALANCE_NOTE_FAILED workspace=<id> code=note_failed` (the id and a fixed code, never an address or
// the text of the database) and skipped; the charge, the credit or the refusal commits, the workspace is simply not told this time.
import "server-only";
import { sql, type Kysely } from "kysely";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import {
  createWorkspacesRepository,
  isDeleted,
} from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  BALANCE_NOTIFICATION_KINDS,
  kindsInStateOf,
} from "../db/balance-state.ts";
import { readBillingSwitch } from "./enabled.ts";

export type BalanceMove = "down" | "up";

/** What the decision did, for the callers that care and for the tests. */
export type BalanceNoteResult =
  | { state: "off" }
  | { state: "deleted" }
  | { state: "noted"; mailDue: boolean };

export async function noteBalanceMoved(
  trx: Kysely<Database>,
  input: { workspaceId: string; move: BalanceMove; now: () => Date },
): Promise<BalanceNoteResult> {
  const billing = await readBillingSwitch(trx);
  if (!billing.enabled || billing.missing.length > 0) return { state: "off" };
  // A deleted workspace (#658) has nobody to tell and no state to keep: a late entry of its journal (a refund, a correction of
  // an operator) leaves no notification behind.
  const workspace = await createWorkspacesRepository(trx).getIncludingDeleted(
    input.workspaceId,
  );
  if (workspace !== undefined && isDeleted(workspace))
    return { state: "deleted" };
  const row = await trx
    .selectFrom("billing_balances")
    .select("balance_micro_usd")
    .where("workspace_id", "=", input.workspaceId)
    .executeTakeFirst();
  const balance = row === undefined ? 0 : Number(row.balance_micro_usd);
  const inState = kindsInStateOf(balance, billing.lowBalanceMicroUsd);
  const notifications = createBillingNotificationsRepository(
    trx,
    input.workspaceId,
    input.now,
  );
  const known = new Map(
    (await notifications.list()).map((entry) => [entry.kind, entry.state]),
  );
  let mailDue = false;
  for (const kind of BALANCE_NOTIFICATION_KINDS) {
    const sent = known.get(kind) === "sent";
    if (!inState[kind]) {
      if (sent) await notifications.rearm(kind);
      continue;
    }
    if (sent) continue;
    const mail = input.move === "down" && !mailDue;
    if ((await notifications.markSent(kind, mail ? "due" : "none")) && mail)
      mailDue = true;
  }
  return { state: "noted", mailDue };
}

const SAVEPOINT = "billing_balance_note";
export const BALANCE_NOTE_FAILED_LOG_CODE = "BALANCE_NOTE_FAILED";

/** Runs `work` in a savepoint of the caller's transaction; a failure is undone, logged with a stable code and swallowed. */
export async function guardedBalanceNote(
  trx: Kysely<Database>,
  workspaceId: string,
  work: () => Promise<unknown>,
): Promise<void> {
  await sql.raw(`savepoint ${SAVEPOINT}`).execute(trx);
  try {
    await work();
    await sql.raw(`release savepoint ${SAVEPOINT}`).execute(trx);
  } catch {
    await sql.raw(`rollback to savepoint ${SAVEPOINT}`).execute(trx);
    console.warn(
      `[billing] ${BALANCE_NOTE_FAILED_LOG_CODE} workspace=${workspaceId} code=note_failed`,
    );
  }
}

/** `noteBalanceMoved` that cannot fail its caller: see the top of the file. */
export function noteBalanceMovedSafely(
  trx: Kysely<Database>,
  input: { workspaceId: string; move: BalanceMove; now: () => Date },
): Promise<void> {
  return guardedBalanceNote(trx, input.workspaceId, () =>
    noteBalanceMoved(trx, input),
  );
}
