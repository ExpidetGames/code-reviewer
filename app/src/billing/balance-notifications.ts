// SPDX-License-Identifier: Apache-2.0

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
import "server-only";
import type { Kysely } from "kysely";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import type { Database } from "../db/schema.ts";
import { BALANCE_NOTIFICATION_KINDS, kindsInStateOf } from "./balance-state.ts";
import { readBillingSwitch } from "./enabled.ts";

export type BalanceMove = "down" | "up";

/** What the decision did, for the callers that care and for the tests. */
export type BalanceNoteResult =
  | { state: "off" }
  | { state: "noted"; mailDue: boolean };

export async function noteBalanceMoved(
  trx: Kysely<Database>,
  input: { workspaceId: string; move: BalanceMove; now: () => Date },
): Promise<BalanceNoteResult> {
  const billing = await readBillingSwitch(trx);
  if (!billing.enabled || billing.missing.length > 0) return { state: "off" };
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
    if (await notifications.markSent(kind, mail ? "due" : "none") && mail)
      mailDue = true;
  }
  return { state: "noted", mailDue };
}
