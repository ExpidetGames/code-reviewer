// Helpers of the backup tests: a database that holds data of every kind the app stores, row counts
// and integrity checks read through a connection of their own (never through the code under test),
// and a writer in a separate OS process for "another process writes while the backup runs".
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import type { Kysely } from "kysely";
import { afterEach } from "vitest";
import type { Database } from "../db/schema.ts";

const TIMESTAMP = "2026-10-10T10:00:00.000Z";

/** Rows in every table that the app fills: sign in (users, sessions, accounts), GitHub and projects. */
export async function seedInstance(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto("users")
    .values(
      ["ada", "grace"].map((login) => ({
        id: `user-${login}`,
        name: login,
        email: `${login}@example.test`,
        email_verified: 1,
        image: null,
        github_login: login,
        org_checked_at: null,
        org_checked_for: null,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      })),
    )
    .execute();
  await db
    .insertInto("sessions")
    .values({
      id: "session-1",
      expires_at: "2026-11-10T10:00:00.000Z",
      token: "dummy-session-token-for-tests",
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
      ip_address: null,
      user_agent: null,
      user_id: "user-ada",
    })
    .execute();
  await db
    .insertInto("integrations")
    .values({
      id: "integration-1",
      type: "github_app",
      display_name: "Example",
      external_id: "42",
      config: "{}",
      credentials: null,
      webhook_secret: null,
      status: "active",
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    })
    .execute();
  await db
    .insertInto("repositories")
    .values({
      id: "repository-1",
      integration_id: "integration-1",
      external_id: "1001",
      full_name: "example/app",
      url: "https://github.test/example/app",
      active: 1,
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    })
    .execute();
  await db
    .insertInto("projects")
    .values({
      id: "project-1",
      repository_id: "repository-1",
      active: 1,
      settings: "{}",
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    })
    .execute();
}

/** Table name -> number of rows, for every table of the file (read through a read-only connection). */
export function tableCounts(path: string): Record<string, number> {
  const sqlite = new BetterSqlite3(path, { readonly: true });
  try {
    const tables = sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (
          sqlite.prepare(`select count(*) as n from "${name}"`).get() as {
            n: number;
          }
        ).n,
      ]),
    );
  } finally {
    sqlite.close();
  }
}

/** What `PRAGMA integrity_check` answers for the file ("ok" when it is sound). */
export function integrityOf(path: string): string {
  const sqlite = new BetterSqlite3(path, { readonly: true });
  try {
    const rows = sqlite.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    return rows.map((row) => row.integrity_check).join("\n");
  } finally {
    sqlite.close();
  }
}

/** The names in a directory, without the ones a test does not care about (none are hidden). */
export function namesIn(directory: string): string[] {
  return readdirSync(directory).sort();
}

const writerScript = fileURLToPath(
  new URL("./backup-writer-child.ts", import.meta.url),
);
const running = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
});

export type BackgroundWriter = {
  /** Resolves once the writer has committed at least `count` transactions. */
  committed(count: number): Promise<void>;
  stop(): void;
};

/**
 * Starts a process that commits, in a loop, one transaction that writes the same key into two
 * tables (`app_meta` and `app_settings`). A snapshot that shows a key in one table and not in the
 * other would show half a transaction.
 */
export async function startBackgroundWriter(
  databasePath: string,
): Promise<BackgroundWriter> {
  const child = spawn(
    process.execPath,
    ["--no-warnings", writerScript, "write", databasePath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  running.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  let commits = 0;
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    commits = Number(line);
    for (const entry of waiting.filter((w) => commits >= w.count)) {
      waiting.splice(waiting.indexOf(entry), 1);
      entry.resolve();
    }
  });
  const exited = new Promise<never>((_, reject) =>
    child.once("exit", (code) =>
      reject(new Error(`writer exited with ${code}: ${stderr}`)),
    ),
  );
  exited.catch(() => undefined);

  const writer: BackgroundWriter = {
    committed: (count) =>
      commits >= count
        ? Promise.resolve()
        : Promise.race([
            new Promise<void>((resolve) => waiting.push({ count, resolve })),
            exited,
          ]),
    stop: () => void child.kill("SIGKILL"),
  };
  await writer.committed(1);
  return writer;
}

/** Keys that exist in both tables, only in `app_meta`, and only in `app_settings`. */
export function writerKeys(path: string): {
  both: number;
  onlyMeta: number;
  onlySettings: number;
} {
  const sqlite = new BetterSqlite3(path, { readonly: true });
  try {
    const count = (sql: string): number =>
      (sqlite.prepare(sql).get() as { n: number }).n;
    return {
      both: count(
        "select count(*) as n from app_meta m join app_settings s on s.key = m.key where m.key like 'w-%'",
      ),
      onlyMeta: count(
        "select count(*) as n from app_meta m where m.key like 'w-%' and m.key not in (select key from app_settings)",
      ),
      onlySettings: count(
        "select count(*) as n from app_settings s where s.key like 'w-%' and s.key not in (select key from app_meta)",
      ),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * Starts a process that takes the database for itself, so that any other connection gets
 * SQLITE_BUSY ("permanently locked"). Resolves once it holds the lock.
 */
export async function holdDatabaseExclusively(
  databasePath: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--no-warnings", writerScript, "lock", databasePath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  running.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: child.stdout }).once("line", () => resolve());
    child.once("exit", (code) =>
      reject(new Error(`lock holder exited with ${code}: ${stderr}`)),
    );
  });
}
