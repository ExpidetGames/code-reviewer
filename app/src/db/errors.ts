// Stable error codes of the database layer. Callers branch on `code`, never on the message text.
export const DATABASE_ERROR_CODES = [
  "DATABASE_CONFIG_INVALID",
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
