// SPDX-License-Identifier: Apache-2.0

// Stable error codes of the backup and restore code. Callers branch on `code`, never on the message
// text. Messages name paths and error codes of the operating system, never data from the database.
export const BACKUP_ERROR_CODES = [
  "BACKUP_CONFIG_INVALID",
  "BACKUP_STATUS_UNAVAILABLE",
  "BACKUP_SOURCE_MISSING",
  "BACKUP_SOURCE_INVALID",
  "BACKUP_SOURCE_LOCKED",
  "BACKUP_TARGET_UNAVAILABLE",
  "BACKUP_TARGET_INSIDE_DATA",
  "BACKUP_WRITE_FAILED",
  "BACKUP_VERIFY_FAILED",
  "RESTORE_BACKUP_MISSING",
  "RESTORE_BACKUP_INVALID",
  "RESTORE_FAILED",
] as const;

export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(
    code: BackupErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BackupError";
    this.code = code;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `code` of a Node or SQLite error such as "ENOENT" or "SQLITE_BUSY", if it has one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
