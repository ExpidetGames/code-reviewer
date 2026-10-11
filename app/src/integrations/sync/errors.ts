// SPDX-License-Identifier: Apache-2.0

// The stable error codes of the sync route. A caller (the page, a test) branches on `code`, never on
// the message; the UI translates codes to copy.
export const SYNC_ERROR_CODES = [
  /** The request does not come from this site (cross-site `Sec-Fetch-Site` or a foreign `Origin`). 403. */
  "SYNC_CROSS_SITE_REQUEST",
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];
