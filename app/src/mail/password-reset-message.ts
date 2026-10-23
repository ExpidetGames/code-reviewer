// SPDX-License-Identifier: Apache-2.0

// The text of the mail that carries a password reset link. Plain text and a small HTML alternative. The link
// is the only secret in it. It is built from the configured public address of the app, never from a request
// header (a forged `Host` header must not make the app mail a link to another site). The page behind the link
// is the one `admin reset-password` prints a link to: the token is a link of 256 random bits that works
// once within 30 minutes (src/auth/password-reset.ts).
import { RESET_PAGE_PATH } from "../admin-cli/reset-link.ts";
import { escapeHtml } from "./html.ts";
import type { MailMessage } from "./sender.ts";

export function passwordResetLink(baseUrl: string, token: string): string {
  const url = new URL(RESET_PAGE_PATH, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function passwordResetMessage({
  to,
  link,
  validForMinutes,
}: {
  to: string;
  link: string;
  validForMinutes: number;
}): MailMessage {
  const minutes = String(validForMinutes);
  const text = [
    "Reset your password",
    "",
    `Someone asked to reset the password of your code-review.com account. Open this link to choose a new password (the link works once and for ${minutes} minutes):`,
    "",
    link,
    "",
    "If this was not you, ignore this message: nothing changes until the link is used.",
  ].join("\n");
  const html = [
    "<p>Reset your password</p>",
    `<p>Someone asked to reset the password of your code-review.com account. Open this link to choose a new password (the link works once and for ${minutes} minutes):</p>`,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    "<p>If this was not you, ignore this message: nothing changes until the link is used.</p>",
  ].join("\n");
  return { to, subject: "Reset your password", text, html };
}
