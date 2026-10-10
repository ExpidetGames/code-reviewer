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
  return { path, busyTimeoutMs: parseBusyTimeout(env.DATABASE_BUSY_TIMEOUT_MS) };
}

function parseBusyTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BUSY_TIMEOUT_MS;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  throw new DatabaseError(
    "DATABASE_CONFIG_INVALID",
    `DATABASE_BUSY_TIMEOUT_MS must be a positive whole number of milliseconds, got "${raw}".`,
  );
}
