// Reads the database settings from the environment. The only place that knows the variable names.
import { DatabaseError } from "./errors.ts";

export const DEFAULT_DATABASE_PATH = "/data/app.db";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export type DatabaseConfig = {
  /** Absolute or relative path of the SQLite file. Its directory must already exist. */
  path: string;
  /** How long a statement waits for a lock held by another connection before it fails. */
  busyTimeoutMs: number;
};

export function loadDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): DatabaseConfig {
  const path = env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
  return {
    path,
    busyTimeoutMs: parseBusyTimeout(env.DATABASE_BUSY_TIMEOUT_MS),
  };
}

// SQLite stores the timeout as a 32 bit integer; a larger value would be rejected later, at open.
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;

function parseBusyTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUSY_TIMEOUT_MS;
  const text = raw.trim();
  const value = Number(text);
  // Plain digits only: Number() would also accept "1e3", "0x10" and "+5".
  if (/^\d+$/.test(text) && value > 0 && value <= MAX_BUSY_TIMEOUT_MS)
    return value;
  throw new DatabaseError(
    "DATABASE_CONFIG_INVALID",
    `DATABASE_BUSY_TIMEOUT_MS must be a whole number of milliseconds between 1 and ${MAX_BUSY_TIMEOUT_MS}, got "${raw}".`,
  );
}
