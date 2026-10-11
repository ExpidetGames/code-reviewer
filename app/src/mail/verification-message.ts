// SPDX-License-Identifier: Apache-2.0

// The text of the mail that carries a verification link. Plain text and a small HTML alternative. The
// link is the only secret in it; the message never contains a password. The address of the link is built
// from the configured public address of the app, never from a request header (a forged `Host` header
// must not make the app mail a link to another site).
import type { MailMessage } from "./sender.ts";

/** The path the link opens; the page behind it asks for one more click before it verifies. */
export const VERIFY_EMAIL_PATH = "/verify-email";

export function verificationLink(baseUrl: string, token: string): string {
  const url = new URL(VERIFY_EMAIL_PATH, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function verificationMessage({
  to,
  link,
  validForHours,
}: {
  to: string;
  link: string;
  validForHours: number;
}): MailMessage {
  const text = [
    "Confirm your email address",
    "",
    "Someone created an account at Code Reviewer with this email address. Open this link to confirm it",
    `(it works once and for ${String(validForHours)} hours):`,
    "",
    link,
    "",
    "If this was not you, ignore this message: the account stays unusable until the address is confirmed.",
  ].join("\n");
  const html = [
    "<p>Confirm your email address</p>",
    "<p>Someone created an account at Code Reviewer with this email address. Open this link to confirm it",
    `(it works once and for ${String(validForHours)} hours):</p>`,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    "<p>If this was not you, ignore this message: the account stays unusable until the address is confirmed.</p>",
  ].join("\n");
  return { to, subject: "Confirm your email address", text, html };
}
