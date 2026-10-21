// SPDX-License-Identifier: Apache-2.0

// Stable error codes of the database layer. Callers branch on `code`, never on the message text.
export const DATABASE_ERROR_CODES = [
  "DATABASE_CONFIG_INVALID",
  "DATABASE_SERVERLESS_NEEDS_POSTGRES",
  "DATABASE_DIRECTORY_UNAVAILABLE",
  "DATABASE_OPEN_FAILED",
  "DATABASE_LOCKED",
  "MIGRATION_FAILED",
] as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[number];

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(
    code: DatabaseErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DatabaseError";
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

/**
 * Whether a failed statement may work if asked again later, without anything being wrong in the data or the statement: a
 * serialization failure or a deadlock (SQLSTATE class 40), a lock that could not be taken (55P03), a statement that was
 * cancelled or timed out (57014), too many connections or no resources (class 53), a connection that failed (class 08), and a
 * busy or locked SQLite database. Everything else, a table or column that is missing (42), a value of the wrong shape (22),
 * a violated constraint (23) and an error without a code, is deterministic: asking again gives the same answer.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined) return false;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
    return true;
  return (
    /^(40|53|08)[0-9A-Z]{3}$/.test(code) || code === "55P03" || code === "57014"
  );
}
