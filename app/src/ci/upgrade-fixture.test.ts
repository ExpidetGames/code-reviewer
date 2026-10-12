// SPDX-License-Identifier: Apache-2.0

// The database that docker/smoke/upgrade.sh puts into the image's volume (docker/smoke/fixtures/previous-release.sql)
// is the previous release's, frozen as a text dump. It must stay exactly that: the migrations it records are the
// ones before accounts, it loads into a database, and the current migrations take it to the latest schema. A
// change of the migrations that breaks the update of an installation shows here before it shows in the image.
import BetterSqlite3 from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection.ts";
import { migrateToLatest } from "../db/migrate.ts";
import { previousReleaseMigrations } from "../test-support/legacy-installation.ts";
import { createTestDirectory, track } from "../test-support/test-database.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dump = readFileSync(
  `${repoRoot}docker/smoke/fixtures/previous-release.sql`,
  "utf8",
);

async function loadFixture(): Promise<string> {
  const directory = await createTestDirectory();
  const path = join(directory, "app.db");
  const db = new BetterSqlite3(path);
  db.exec(dump);
  db.close();
  return path;
}

describe("the database of the previous release in the smoke test of the update", () => {
  // #106-IM-20
  it("records exactly the migrations of the previous release", async () => {
    const path = await loadFixture();
    const db = new BetterSqlite3(path, { readonly: true });
    const recorded = (
      db
        .prepare("select name from kysely_migration order by name")
        .all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    db.close();

    expect(recorded).toEqual(
      Object.keys(await previousReleaseMigrations.getMigrations()).sort(),
    );
  });

  // #106-IM-20
  it("holds an installation with people, a connection, a project and finished reviews", async () => {
    const path = await loadFixture();
    const db = new BetterSqlite3(path, { readonly: true });
    const count = (table: string) =>
      (db.prepare(`select count(*) as n from ${table}`).get() as { n: number })
        .n;
    const counts = {
      users: count("users"),
      integrations: count("integrations"),
      repositories: count("repositories"),
      projects: count("projects"),
      jobs: count("jobs"),
      allowed_login_pins: count("allowed_login_pins"),
    };
    db.close();

    expect(counts).toEqual({
      users: 3,
      integrations: 1,
      repositories: 2,
      projects: 1,
      jobs: 2,
      allowed_login_pins: 1,
    });
  });

  // #106-IM-20
  it("migrates to the latest schema with every row kept, in one default workspace", async () => {
    const path = await loadFixture();
    const db = track(
      openDatabase({ driver: "sqlite", path, busyTimeoutMs: 5000 }),
    );

    await migrateToLatest(db);

    expect(await db.selectFrom("users").select("id").execute()).toHaveLength(3);
    expect(await db.selectFrom("jobs").select("id").execute()).toHaveLength(2);
    expect(await db.selectFrom("workspaces").select("slug").execute()).toEqual([
      { slug: "default" },
    ]);
  });

  // #118-T03 (a data file: no secret in it)
  it("holds no secret, only dummy data", () => {
    expect(dump).not.toMatch(/-----BEGIN|ghp_|github_pat_|sk-or-/);
  });
});
