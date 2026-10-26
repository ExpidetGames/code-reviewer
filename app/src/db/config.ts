// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads the database settings from the environment. The only place that knows the variable names.
//
// `DATABASE_URL` is a `postgres://` or `postgresql://` URL (the app role's, a direct or session-mode connection).
// The app runs as serverless functions: every instance has a pool of its own and many run at once, so the pool is
// small and idle connections are released quickly. The migration command reads its own direct URL,
// `DATABASE_URL_MIGRATE`. Nothing here logs a value: a Postgres URL carries a password, so errors name the variable
// and the rule, never the URL. `describeDatabaseTarget` is the one safe form (host and database only).
import { DatabaseError } from "./errors.ts";

/** Every instance has a pool of its own, so the default is small and the limit is low. */
export const DEFAULT_POOL_MAX = 3;
export const MAX_POOL_MAX = 20;
/** An idle connection is closed after this long, so a frozen instance holds none for long. */
export const POOL_IDLE_TIMEOUT_MS = 5000;
/** The migration command runs one transaction; a second connection is spare. */
const MIGRATION_POOL_MAX = 2;

export type PostgresDatabaseConfig = {
  /** The connection URL as configured. Never written to a log as it is. */
  url: string;
  /** The most connections the pool opens. */
  poolMax: number;
  /** How long an idle connection stays open. Absent: the driver's default. */
  idleTimeoutMs?: number;
  /** Tell the platform when the pool is idle so it can wait for it. */
  attachPlatformPool?: boolean;
};

export type DatabaseConfig = PostgresDatabaseConfig;

type Env = Readonly<Record<string, string | undefined>>;

/** Whether a URL names Postgres. Case- and whitespace-insensitive. */
function isPostgresUrl(value: string | undefined): boolean {
  const url = value?.trim().toLowerCase() ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export function loadDatabaseConfig(env: Env): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url || !isPostgresUrl(url))
    throw new DatabaseError(
      "DATABASE_CONFIG_INVALID",
      "DATABASE_URL must be set to a postgres:// or postgresql:// URL.",
    );
  const parsed = parseUrl(url, "DATABASE_URL");
  return {
    url: parsed,
    poolMax: parsePoolMax(
      env.DATABASE_POOL_MAX,
      DEFAULT_POOL_MAX,
      MAX_POOL_MAX,
    ),
    idleTimeoutMs: POOL_IDLE_TIMEOUT_MS,
    attachPlatformPool: true,
  };
}

/**
 * The direct Postgres connection of `pnpm migrate`: `DATABASE_URL_MIGRATE`, never `DATABASE_URL`. The
 * pooled URL may sit behind a pooler that does not keep a session, and the advisory lock of the migration
 * needs one.
 */
export function loadMigrationDatabaseConfig(env: Env): PostgresDatabaseConfig {
  const url = env.DATABASE_URL_MIGRATE?.trim();
  if (!url || !isPostgresUrl(url))
    throw new DatabaseError(
      "DATABASE_CONFIG_INVALID",
      "DATABASE_URL_MIGRATE must be set to a direct postgres:// or postgresql:// URL of the database to migrate.",
    );
  return {
    url: parseUrl(url, "DATABASE_URL_MIGRATE"),
    poolMax: MIGRATION_POOL_MAX,
  };
}

function parseUrl(url: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidUrl("it is not a valid URL", variable);
  }
  if (!parsed.hostname) throw invalidUrl("it names no host", variable);
  return url;
}

/** A Postgres URL is never repeated in the message: it carries the password. */
function invalidUrl(problem: string, variable: string): DatabaseError {
  return new DatabaseError(
    "DATABASE_CONFIG_INVALID",
    `${variable} is not usable: ${problem}. Use a postgres:// or postgresql:// URL.`,
  );
}

/** A safe form of a target for a log line: host and database only, never the credentials. */
export function describeDatabaseTarget(config: DatabaseConfig): string {
  try {
    const parsed = new URL(config.url);
    return `postgres://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "postgres://";
  }
}

function parsePoolMax(
  raw: string | undefined,
  defaultValue: number,
  limit: number,
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const text = raw.trim();
  const value = Number(text);
  if (/^\d+$/.test(text) && value > 0 && value <= limit) return value;
  throw new DatabaseError(
    "DATABASE_CONFIG_INVALID",
    `DATABASE_POOL_MAX must be a whole number of connections between 1 and ${limit}, got "${raw}".`,
  );
}
