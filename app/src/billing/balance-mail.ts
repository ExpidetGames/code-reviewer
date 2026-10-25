// SPDX-License-Identifier: LicenseRef-Proprietary

// The delivery of the balance mails (ADR 0006, D9; #506). The decision that a workspace is to be told is made in the transaction
// that moved its balance (`balance-notifications.ts`) and leaves a mail `due`; this runs AFTER the response, claims what is due
// (each crossing goes to exactly one sender, however many run) and mails every Owner and Admin of the workspace through the
// instance's mail sender. It is best effort and cannot fail anything: it never throws, a failure is one log line with a stable code
// (`BALANCE_MAIL_FAILED code=mail_failed|not_configured|no_recipients|stale`) naming the workspace and the kind and never an
// address or a message, and a crossing is not mailed again (a retry could repeat a mail the server did accept).
//
// What a mail says is `mail/balance-message.ts`: the balance of that workspace and the link to its billing page, built from the
// configured public address. With billing off nothing is claimed and nothing is read but the switch.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationDirectory } from "../db/repositories/billing-notification-directory-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import {
  createWorkspacesRepository,
  isDeleted,
} from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  balanceMessage,
  type BalanceMailLevel,
} from "../mail/balance-message.ts";
import type { MailSender } from "../mail/sender.ts";
import { formatMoney } from "../workspace-billing/money.ts";
import { workspacePath } from "../workspaces/paths.ts";
import { can } from "../workspaces/permissions.ts";
import {
  balanceLevelOf,
  kindsInStateOf,
  type BalanceNotificationKind,
} from "./balance-state.ts";
import { readBillingSwitch } from "./enabled.ts";

/** The stable codes of the log line of a delivery that did not reach anybody. */
export const BALANCE_MAIL_FAILURE_CODES = [
  "mail_failed",
  "not_configured",
  "no_recipients",
  "stale",
] as const;
export type BalanceMailFailureCode =
  (typeof BALANCE_MAIL_FAILURE_CODES)[number];

/** How many crossings one delivery works through; the rest wait for the next. */
const BATCH = 20;
/** The most people one crossing is mailed to: a workspace has few Owners and Admins, and a send is one SMTP delivery each. */
const MAX_RECIPIENTS = 20;

export type BalanceMailDelivery = {
  db: Kysely<Database>;
  mail: MailSender;
  /** The configured public address of the app, never a request header. */
  baseUrl: string;
  now?: () => Date;
  log?: (line: string) => void;
};

export type BalanceMailResult = { delivered: number; failed: number };

type Outcome =
  | { delivered: true }
  /** Nobody is to be told: the workspace was deleted meanwhile (#658). Not a failure, so not counted and not logged. */
  | { delivered: false; skipped: true }
  | {
      delivered: false;
      skipped?: undefined;
      code: BalanceMailFailureCode;
      recipients: number;
    };

/** Mails every crossing that is due. Never throws. */
export async function deliverDueBalanceMails(
  options: BalanceMailDelivery,
): Promise<BalanceMailResult> {
  const result: BalanceMailResult = { delivered: 0, failed: 0 };
  const log = options.log ?? console.error;
  try {
    const billing = await readBillingSwitch(options.db);
    if (!billing.enabled || billing.missing.length > 0) return result;
    const directory = createBillingNotificationDirectory(
      options.db,
      options.now,
    );
    for (const due of await directory.claimDue(BATCH)) {
      let outcome: Outcome;
      try {
        outcome = await deliverOne(options, due, billing.lowBalanceMicroUsd);
      } catch {
        outcome = { delivered: false, code: "mail_failed", recipients: 0 };
      }
      await directory.finish(
        due.workspaceId,
        due.kind,
        outcome.delivered ? "delivered" : outcome.skipped ? "none" : "failed",
      );
      if (outcome.delivered) result.delivered += 1;
      else if (outcome.skipped) continue;
      else {
        result.failed += 1;
        log(
          `[billing] BALANCE_MAIL_FAILED workspace=${due.workspaceId} kind=${due.kind} code=${outcome.code} recipients=${String(outcome.recipients)}`,
        );
      }
    }
  } catch {
    log("[billing] BALANCE_MAIL_FAILED code=unavailable");
  }
  return result;
}

async function deliverOne(
  options: BalanceMailDelivery,
  due: { workspaceId: string; kind: BalanceNotificationKind },
  lowBalanceMicroUsd: number,
): Promise<Outcome> {
  const { db, mail } = options;
  const { balanceMicroUsd } = await createBillingJournalRepository(
    db,
    due.workspaceId,
    options.now,
  ).balance();
  // The balance may have been lifted between the decision and now: the mail would tell a workspace about a state it is out of.
  if (!kindsInStateOf(balanceMicroUsd, lowBalanceMicroUsd)[due.kind])
    return { delivered: false, code: "stale", recipients: 0 };
  const workspace = await createWorkspacesRepository(db).getIncludingDeleted(
    due.workspaceId,
  );
  if (workspace !== undefined && isDeleted(workspace))
    return { delivered: false, skipped: true };
  const members = await createWorkspaceMembersRepository(
    db,
    due.workspaceId,
  ).list();
  const recipients = members
    .filter((member) => can(member.role, "manage_billing"))
    .slice(0, MAX_RECIPIENTS);
  if (workspace === undefined || recipients.length === 0)
    return { delivered: false, code: "no_recipients", recipients: 0 };
  const level = balanceLevelOf(balanceMicroUsd, lowBalanceMicroUsd);
  const mailLevel: BalanceMailLevel =
    due.kind === "low" ? "low" : level === "negative" ? "negative" : "empty";
  const link = new URL(
    workspacePath(workspace.slug, "/settings/billing"),
    options.baseUrl,
  ).toString();
  let reached = 0;
  let code: BalanceMailFailureCode = "mail_failed";
  for (const member of recipients) {
    const sent = await mail.send(
      balanceMessage({
        to: member.email,
        level: mailLevel,
        workspaceName: workspace.name,
        balanceText: formatMoney(balanceMicroUsd),
        link,
      }),
    );
    if (sent.ok) reached += 1;
    else code = sent.error;
  }
  return reached > 0
    ? { delivered: true }
    : { delivered: false, code, recipients: recipients.length };
}
