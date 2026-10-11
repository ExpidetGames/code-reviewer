// SPDX-License-Identifier: Apache-2.0

// Pins down the connection settings the app relies on (WAL, busy timeout, foreign keys) and the
// refusals when the database file cannot be opened.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { startDbProcess } from "../test-support/db-process.ts";
import {
  createTestDatabase,
  createTestDirectory,
  track,
} from "../test-support/test-database.ts";
import { openDatabase } from "./connection.ts";
import { DatabaseError } from "./errors.ts";
import type { Database } from "./schema.ts";

async function pragma(db: Kysely<Database>, name: string): Promise<unknown> {
  const { rows } = await sql<
    Record<string, unknown>
  >`${sql.raw(`pragma ${name}`)}`.execute(db);
  return Object.values(rows[0] ?? {})[0];
}

describe("openDatabase", () => {
  // CR-15-T03
  it("opens in WAL mode with the configured busy timeout", async () => {
    const { db } = await createTestDatabase({ busyTimeoutMs: 1234 });

    expect(await pragma(db, "journal_mode")).toBe("wal");
    expect(await pragma(db, "busy_timeout")).toBe(1234);
  });

  // CR-15-T12
  it("enforces foreign keys by rejecting a row that points at an unknown parent", async () => {
    const { db } = await createTestDatabase();
    await db.schema
      .createTable("parent")
      .addColumn("id", "text", (c) => c.primaryKey())
      .execute();
    await db.schema
      .createTable("child")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("parent_id", "text", (c) =>
        c.notNull().references("parent.id"),
      )
      .execute();
    // The tables are not part of the app schema, so they are used through an untyped handle.
    const untyped = db as unknown as Kysely<
      Record<string, Record<string, unknown>>
    >;

    const insert = untyped
      .insertInto("child")
      .values({ id: "c1", parent_id: "missing" })
      .execute();

    expect(await pragma(db, "foreign_keys")).toBe(1);
    await expect(insert).rejects.toThrow(/FOREIGN KEY/);
  });

  describe("when the database directory cannot be used", () => {
    // CR-15-T10
    it("names the missing directory in a stable error", async () => {
      const directory = await createTestDirectory();
      const path = join(directory, "does-not-exist", "app.db");

      const open = () => openDatabase({ path, busyTimeoutMs: 100 });

      expect(open).toThrow(DatabaseError);
      expect(open).toThrow(
        expect.objectContaining({ code: "DATABASE_DIRECTORY_UNAVAILABLE" }),
      );
      expect(open).toThrow(join(directory, "does-not-exist"));
      expect(open).toThrow(/does not exist/);
    });

    // CR-15-T10
    it("refuses a directory path that is really a file", async () => {
      const directory = await createTestDirectory();
      const notADirectory = join(directory, "plain-file");
      await writeFile(notADirectory, "");

      const open = () =>
        openDatabase({
          path: join(notADirectory, "app.db"),
          busyTimeoutMs: 100,
        });

      expect(open).toThrow(
        expect.objectContaining({ code: "DATABASE_DIRECTORY_UNAVAILABLE" }),
      );
      expect(open).toThrow(/is not a directory/);
    });

    // CR-15-T10
    it("reports a permission problem instead of a missing directory when a parent cannot be entered", async () => {
      const directory = await createTestDirectory();
      const closed = join(directory, "closed");
      await mkdir(join(closed, "inner"), { recursive: true });
      await chmod(closed, 0o000);

      try {
        const open = () =>
          openDatabase({
            path: join(closed, "inner", "app.db"),
            busyTimeoutMs: 100,
          });

        expect(open).toThrow(
          expect.objectContaining({ code: "DATABASE_DIRECTORY_UNAVAILABLE" }),
        );
        expect(open).toThrow(/permission denied/);
        expect(open).not.toThrow(/does not exist/);
      } finally {
        await chmod(closed, 0o700);
      }
    });

    // CR-15-T10
    it("refuses a directory the process may not write to", async () => {
      const directory = await createTestDirectory();
      const readOnly = join(directory, "read-only");
      await mkdir(readOnly);
      await chmod(readOnly, 0o500);

      try {
        const open = () =>
          openDatabase({ path: join(readOnly, "app.db"), busyTimeoutMs: 100 });

        expect(open).toThrow(
          expect.objectContaining({ code: "DATABASE_DIRECTORY_UNAVAILABLE" }),
        );
        expect(open).toThrow(/cannot be written to/);
      } finally {
        await chmod(readOnly, 0o700);
      }
    });
  });

  // CR-15-T10
  it("reports a file that is not a database with the path and a stable code", async () => {
    const directory = await createTestDirectory();
    const path = join(directory, "app.db");
    await writeFile(
      path,
      "this is not a sqlite database, it is just long enough to be read\n".repeat(
        20,
      ),
    );

    const open = () => track(openDatabase({ path, busyTimeoutMs: 100 }));

    expect(open).toThrow(
      expect.objectContaining({ code: "DATABASE_OPEN_FAILED" }),
    );
    expect(open).toThrow(path);
  });

  it("refuses a database that cannot use WAL mode instead of running in another journal mode", () => {
    const open = () => openDatabase({ path: ":memory:", busyTimeoutMs: 100 });

    expect(open).toThrow(
      expect.objectContaining({ code: "DATABASE_OPEN_FAILED" }),
    );
    expect(open).toThrow(/WAL mode could not be enabled/);
  });

  it("gives up with DATABASE_OPEN_FAILED when a new file stays locked for longer than the busy timeout", async () => {
    const directory = await createTestDirectory();
    const path = join(directory, "app.db");
    // Another process creates the file and holds its write lock until told to stop.
    const holder = startDbProcess(["hold-lock", path, "0"]);
    expect(await holder.nextLine()).toBe("locked");
    const started = Date.now();

    const open = () => openDatabase({ path, busyTimeoutMs: 300 });

    expect(open).toThrow(
      expect.objectContaining({ code: "DATABASE_OPEN_FAILED" }),
    );
    expect(open).toThrow(/database is locked/);
    expect(Date.now() - started).toBeLessThan(5000);
    holder.closeInput();
    expect(await holder.nextLine()).toBe("released");
  });
});
