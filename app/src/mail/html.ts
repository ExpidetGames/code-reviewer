// SPDX-License-Identifier: LicenseRef-Proprietary

// The one way the HTML bodies of the mails escape text that comes from outside (a link, an address of the app).

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
