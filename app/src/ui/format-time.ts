// SPDX-License-Identifier: LicenseRef-Proprietary

// Times as text the server and the browser render the same way (UTC, no locale), so a page that is
// rendered on the server and again in the browser does not differ between the two.

/** "2026-10-10 12:34 UTC", or "unknown time" for something that is not a time. */
export function formatUtc(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "unknown time";
  return `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
