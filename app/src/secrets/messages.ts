// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy about a stored secret (the SMTP password, the GitHub App's key, the LLM key): what it means
// that a value cannot be read and what the person is told about a value they leave. One owner per fact
// (#169); the pages import these and never word them again.

/** A stored value that cannot be decrypted: the master key changed, or the row did. */
export const UNREADABLE_SECRET_CAUSE =
  "It was saved with another APP_SECRET, or the stored value was changed.";

/** What every secret field says about the value once it is saved. */
export const STORED_ENCRYPTED_HINT =
  "It is stored encrypted and is never shown again.";
