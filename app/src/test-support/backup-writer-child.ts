// A process that uses the database next to a backup (see backup-harness.ts). It runs until it is
// killed.
//
//   write <db>   writes in a loop: each transaction inserts the same key into app_meta and
//                app_settings; after every commit it prints the number of commits so far, one per line
//   lock <db>    takes the database for itself (exclusive locking mode, an open write) so that every
//                other connection gets SQLITE_BUSY, and prints "locked"
import BetterSqlite3 from "better-sqlite3";

const [command, databasePath] = process.argv.slice(2);
if (!databasePath || (command !== "write" && command !== "lock"))
  throw new Error("Usage: backup-writer-child.ts <write|lock> <database>");

const sqlite = new BetterSqlite3(databasePath, { timeout: 5000 });
sqlite.pragma("journal_mode = WAL");

if (command === "lock") {
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
  const insertMeta = sqlite.prepare(
    "insert into app_meta (key, value, updated_at) values (?, ?, ?)",
  );
  const insertSetting = sqlite.prepare(
    "insert into app_settings (key, value, updated_at, updated_by) values (?, ?, ?, null)",
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
