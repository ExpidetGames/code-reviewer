// Stable error codes of the database layer. Callers branch on `code`, never on the message text.
export const DATABASE_ERROR_CODES = [
  "DATABASE_CONFIG_INVALID",
  "DATABASE_DIRECTORY_UNAVAILABLE",
  "DATABASE_OPEN_FAILED",
  "MIGRATION_FAILED",
] as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[number];

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseError";
    this.code = code;
  }
}
