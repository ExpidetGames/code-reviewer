// SPDX-License-Identifier: Apache-2.0

// Reads the database settings from the environment. The only place that knows the variable names.
//
// `DATABASE_URL` selects the database (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.1): empty, a path or a `sqlite:` URL means SQLite (the default file stays `/data/app.db`);
// `postgres://` or `postgresql://` means Postgres. `DATABASE_PATH` keeps working for installations
// that never set `DATABASE_URL`. Nothing here logs a value: a Postgres URL carries a password, so
// errors name the variable and the rule, never the URL. `describeDatabaseTarget` is the one safe
// form (host and database only) for the start line.
import { DatabaseError } from "./errors.ts";

export const DEFAULT_DATABASE_PATH = "/data/app.db";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_POOL_MAX = 10;
const MAX_POOL_MAX = 1000;

export type SqliteDatabaseConfig = {
  driver: "sqlite";
  /** Absolute or relative path of the SQLite file. Its directory must already exist. */
  path: string;
  /** How long a statement waits for a lock held by another connection before it fails. */
  busyTimeoutMs: number;
};

export type PostgresDatabaseConfig = {
  driver: "postgres";
  /** The connection URL as configured. Never written to a log as it is. */
  url: string;
  /** The most connections the pool opens. */
  poolMax: number;
};

export type DatabaseConfig = SqliteDatabaseConfig | PostgresDatabaseConfig;

/**
 * Whether a `DATABASE_URL` value names Postgres. Case- and whitespace-insensitive, and pure so
 * `loadDatabaseConfig` can branch before it parses anything.
 */
function isPostgresUrl(value: string | undefined): boolean {
  const url = value?.trim().toLowerCase() ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export function loadDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) return sqliteConfig(env);
  if (isPostgresUrl(url)) return postgresConfig(url, env);
  const lower = url.toLowerCase();
  if (lower.startsWith("sqlite:"))
    return {
      driver: "sqlite",
      path: pathFromSqliteUrl(url) || defaultPath(env),
      busyTimeoutMs: parseBusyTimeout(env.DATABASE_BUSY_TIMEOUT_MS),
    };
  // A value with a scheme that is none of the three is a mistake: a path never contains "://".
  if (url.includes("://"))
    throw invalidUrl(
      "its scheme is neither sqlite:, postgres:// nor postgresql://",
    );
  return {
    driver: "sqlite",
    path: url,
    busyTimeoutMs: parseBusyTimeout(env.DATABASE_BUSY_TIMEOUT_MS),
  };
}

function sqliteConfig(
  env: Readonly<Record<string, string | undefined>>,
): SqliteDatabaseConfig {
  return {
    driver: "sqlite",
    path: defaultPath(env),
    busyTimeoutMs: parseBusyTimeout(env.DATABASE_BUSY_TIMEOUT_MS),
  };
}

function defaultPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

/** `sqlite:/data/app.db` and `sqlite:///data/app.db` both name `/data/app.db`. */
function pathFromSqliteUrl(url: string): string {
  let path = url.slice("sqlite:".length);
  if (path.startsWith("//")) path = path.slice(2);
  return path.trim();
}

function postgresConfig(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
): PostgresDatabaseConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidUrl("it is not a valid URL");
  }
  if (!parsed.hostname) throw invalidUrl("it names no host");
  return {
    driver: "postgres",
    url,
    poolMax: parsePoolMax(env.DATABASE_POOL_MAX),
  };
}

/** A Postgres URL is never repeated in the message: it carries the password. */
function invalidUrl(problem: string): DatabaseError {
  return new DatabaseError(
    "DATABASE_CONFIG_INVALID",
    `DATABASE_URL is not usable: ${problem}. Use an empty value, a path or a sqlite: URL for SQLite, ` +
      "or a postgres:// or postgresql:// URL for Postgres.",
  );
}

/** A safe form of a target for a log line: host and database only, never the credentials. */
export function describeDatabaseTarget(config: DatabaseConfig): string {
  if (config.driver === "sqlite") return `sqlite:${config.path}`;
  try {
    const parsed = new URL(config.url);
    return `postgres://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "postgres://";
  }
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

function parsePoolMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_POOL_MAX;
  const text = raw.trim();
  const value = Number(text);
  if (/^\d+$/.test(text) && value > 0 && value <= MAX_POOL_MAX) return value;
  throw new DatabaseError(
    "DATABASE_CONFIG_INVALID",
    `DATABASE_POOL_MAX must be a whole number of connections between 1 and ${MAX_POOL_MAX}, got "${raw}".`,
  );
}
