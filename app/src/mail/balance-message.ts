// SPDX-License-Identifier: LicenseRef-Proprietary

// The text of the mails that tell an Owner or an Admin that the prepaid balance of their workspace is low or empty (ADR 0006, D9;
// #506). Plain text and a small HTML alternative. A mail says what happened, the balance of THAT workspace and where to add
// credit; it never says how a review is priced (no rate, formula, model or provider) and never carries a secret. The link is built
// from the configured public address of the app by the caller, never from a request header. The workspace name is text somebody
// else typed: it is made one line before it goes into the subject or the text, and escaped in the HTML.
import { oneLine } from "../workspaces/names.ts";
import { escapeHtml } from "./html.ts";
import type { MailMessage } from "./sender.ts";

export type BalanceMailLevel = "low" | "empty" | "negative";

function copyOf(
  level: BalanceMailLevel,
  workspace: string,
  balanceText: string,
): { subject: string; headline: string; detail: string } {
  if (level === "low")
    return {
      subject: `Low balance in "${workspace}"`,
      headline: `The prepaid balance of the workspace "${workspace}" at code-review.com is low: ${balanceText} is left.`,
      detail:
        "Reviews keep starting while there is credit. Add credit so they do not stop.",
    };
  return {
    subject: `No credit left in "${workspace}"`,
    headline:
      level === "negative"
        ? `The prepaid balance of the workspace "${workspace}" at code-review.com is below zero: ${balanceText}.`
        : `The prepaid balance of the workspace "${workspace}" at code-review.com has run out: ${balanceText}.`,
    detail:
      "New reviews are not started until credit is added; the pull requests get a notice instead. Reviews that are already running finish.",
  };
}

export function balanceMessage({
  to,
  level,
  workspaceName,
  balanceText,
  link,
}: {
  to: string;
  level: BalanceMailLevel;
  workspaceName: string;
  /** The balance as the billing page shows it (`$3.20`, `-$1.50`). */
  balanceText: string;
  /** The billing page of the workspace. */
  link: string;
}): MailMessage {
  const workspace = oneLine(workspaceName);
  const { subject, headline, detail } = copyOf(level, workspace, balanceText);
  const action = "Open the billing page to add credit:";
  const reason =
    "You get this message because you are an Owner or an Admin of the workspace. It is sent once when the balance drops into this state, and again only after the balance was topped up and has dropped again.";
  const text = [
    subject,
    "",
    headline,
    detail,
    "",
    action,
    link,
    "",
    reason,
  ].join("\n");
  const html = [
    `<p>${escapeHtml(subject)}</p>`,
    `<p>${escapeHtml(headline)}</p>`,
    `<p>${escapeHtml(detail)}</p>`,
    `<p>${escapeHtml(action)} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    `<p>${escapeHtml(reason)}</p>`,
  ].join("\n");
  return { to, subject, text, html };
}
