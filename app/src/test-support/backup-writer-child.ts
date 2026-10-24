// SPDX-License-Identifier: LicenseRef-Proprietary

// A process that uses the database next to a backup (see backup-harness.ts). It runs until it is
// killed.
//
//   write <db>   writes in a loop: each transaction inserts the same key into app_meta and
//                app_settings; after every commit it prints the number of commits so far, one per line
//   idle <db>    opens the database like the running app does (WAL, one read) and keeps it open,
//                doing nothing, and prints "idle"
//   lock <db>    takes the database for itself (exclusive locking mode, an open write) so that every
//                other connection gets SQLITE_BUSY, and prints "locked"
import BetterSqlite3 from "better-sqlite3";

const [command, databasePath] = process.argv.slice(2);
if (
  !databasePath ||
  (command !== "write" && command !== "lock" && command !== "idle")
)
  throw new Error("Usage: backup-writer-child.ts <write|lock|idle> <database>");

const sqlite = new BetterSqlite3(databasePath, { timeout: 5000 });
sqlite.pragma("journal_mode = WAL");

if (command === "idle") {
  sqlite.prepare("select count(*) from sqlite_master").get();
  console.log("idle");
  setInterval(() => undefined, 60_000);
} else if (command === "lock") {
  sqlite.pragma("locking_mode = EXCLUSIVE");
  sqlite.exec("begin immediate");
  sqlite.exec(
    "insert into app_meta (key, value, updated_at) values ('lock', 'held', 'now')",
  );
  console.log("locked");
  setInterval(() => undefined, 60_000);
} else {
  writeForever();
}

function writeForever(): void {
  // The settings it writes belong to a workspace of their own.
  sqlite.exec(
    "insert or ignore into workspaces (id, name, slug, created_by, created_at) values ('writer', 'writer', 'writer', null, 'now')",
  );
  const insertMeta = sqlite.prepare(
    "insert into app_meta (key, value, updated_at) values (?, ?, ?)",
  );
  const insertSetting = sqlite.prepare(
    "insert into app_settings (workspace_id, key, value, updated_at, updated_by) values ('writer', ?, ?, ?, null)",
  );
  const writeBoth = sqlite.transaction((key: string) => {
    const now = new Date().toISOString();
    insertMeta.run(key, "x".repeat(200), now);
    insertSetting.run(key, "{}", now);
  });

  let commits = 0;
  for (;;) {
    writeBoth(`w-${String(commits)}`);
    commits += 1;
    console.log(commits);
    // A short pause keeps the load low while the writes stay frequent.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}
