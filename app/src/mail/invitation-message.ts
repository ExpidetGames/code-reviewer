// SPDX-License-Identifier: LicenseRef-Proprietary

// The text of the mail that carries an invitation link. Plain text and a small HTML alternative. The link is
// the only secret in it. The address of the link is built from the configured public address of the app,
// never from a request header (a forged `Host` header must not make the app mail a link to another site).
//
// The workspace name and the name of the person who invites are text somebody else typed. Both are made one
// line (`oneLine`) before they go into the subject or the text, so a name with a line break cannot start a
// new mail header (an extra `Bcc:`) or a new paragraph, and both are escaped in the HTML.
import { oneLine } from "../workspaces/names.ts";
import { escapeHtml } from "./html.ts";
import type { MailMessage } from "./sender.ts";

/** The path the link opens; the page behind it asks for one more click before it accepts. */
export const INVITATION_PATH = "/invitation";

export function invitationLink(baseUrl: string, token: string): string {
  const url = new URL(INVITATION_PATH, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function invitationMessage({
  to,
  link,
  workspaceName,
  inviterName,
  role,
  validForDays,
}: {
  to: string;
  link: string;
  workspaceName: string;
  inviterName: string;
  role: string;
  validForDays: number;
}): MailMessage {
  const workspace = oneLine(workspaceName);
  const inviter = oneLine(inviterName, 60);
  const intro = `${inviter} invited you to the workspace "${workspace}" at code-review.com as ${role === "admin" ? "an" : "a"} ${role}.`;
  const how = `Open this link, sign in or create an account with this email address, and accept the invitation (the link works once and for ${String(validForDays)} days):`;
  const text = [
    `Join "${workspace}" at code-review.com`,
    "",
    intro,
    how,
    "",
    link,
    "",
    "If you did not expect this, ignore this message: nothing happens until the invitation is accepted.",
  ].join("\n");
  const html = [
    `<p>Join &quot;${escapeHtml(workspace)}&quot; at code-review.com</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p>${escapeHtml(how)}</p>`,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    "<p>If you did not expect this, ignore this message: nothing happens until the invitation is accepted.</p>",
  ].join("\n");
  return {
    to,
    subject: `Join "${workspace}" at code-review.com`,
    text,
    html,
  };
}
