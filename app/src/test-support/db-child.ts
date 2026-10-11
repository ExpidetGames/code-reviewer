// A small program the database integration tests run as a separate OS process (node runs this file
// directly, TypeScript types are stripped). A second process is the only honest way to hold a
// write lock or to start a second app instance, because better-sqlite3 blocks its own thread while
// it waits for a lock. Protocol: one line on stdout per milestone, commands as the first argument.
//
//   hold-lock <db> <ms>   take the write lock, print "locked", release after <ms> (or when stdin
//                         closes if <ms> is 0), print "released"
//   migrate <db>          print "ready", wait for a line "go <epoch ms>" on stdin, spin until that
//                         moment (a start barrier: several processes begin together), then start the
//                         database like the app does and print one JSON line:
//                         {"applied":[...]} or {"error":"CODE"}
//   set-tenancy <db> <actor id> <single|multi>
//   create-workspace <db> <creator id> <slug>
//                         each prints "ready", waits for "go <epoch ms>" like `migrate`, spins until
//                         then, runs the change on its own connection (the admin's switch of the
//                         tenancy, a user's creation of a workspace) and prints its result as one
//                         JSON line. Two of them started together race for the write lock.
import BetterSqlite3 from "better-sqlite3";
import { createInterface } from "node:readline";
import { changeTenancy, type Tenancy } from "../admin/tenancy.ts";
import { openDatabase } from "../db/connection.ts";
import { DatabaseError } from "../db/errors.ts";
import { startDatabase } from "../db/startup.ts";
import { createWorkspaceUnderTenancy } from "../workspaces/create-workspace.ts";

const [command, databasePath, argument, argument2] = process.argv.slice(2);
if (!databasePath)
  throw new Error("Usage: db-child.ts <hold-lock|migrate> <database> [ms]");

if (command === "hold-lock") {
  const sqlite = new BetterSqlite3(databasePath, { timeout: 5000 });
  sqlite.exec("begin immediate");
  console.log("locked");
  const release = () => {
    sqlite.exec("commit");
    sqlite.close();
    console.log("released");
    process.exit(0);
  };
  const holdMs = Number(argument ?? 0);
  if (holdMs > 0) setTimeout(release, holdMs);
  else process.stdin.on("end", release).resume();
} else if (command === "migrate") {
  console.log("ready");
  const lines = createInterface({ input: process.stdin });
  lines.once("line", async (line) => {
    const startAt = Number(line.split(" ")[1]);
    while (Date.now() < startAt);
    try {
      const { db, migrationsApplied } = await startDatabase({
        path: databasePath,
        busyTimeoutMs: 5000,
      });
      await db.destroy();
      console.log(JSON.stringify({ applied: migrationsApplied }));
      process.exit(0);
    } catch (error) {
      const code = error instanceof DatabaseError ? error.code : String(error);
      console.log(JSON.stringify({ error: code }));
      process.exit(1);
    }
  });
} else if (command === "set-tenancy" || command === "create-workspace") {
  console.log("ready");
  const lines = createInterface({ input: process.stdin });
  lines.once("line", async (line) => {
    const startAt = Number(line.split(" ")[1]);
    while (Date.now() < startAt);
    const db = openDatabase({ path: databasePath, busyTimeoutMs: 5000 });
    try {
      const result =
        command === "set-tenancy"
          ? await changeTenancy(db, {
              actorId: argument ?? "",
              tenancy: argument2 as Tenancy,
            })
          : await createWorkspaceUnderTenancy(db, {
              creatorId: argument ?? "",
              name: argument2 ?? "",
              slug: argument2 ?? "",
            });
      console.log(JSON.stringify(result));
      process.exit(0);
    } catch (error) {
      console.log(JSON.stringify({ thrown: String(error) }));
      process.exit(1);
    } finally {
      await db.destroy().catch(() => undefined);
    }
  });
} else {
  throw new Error(`Unknown command: ${command}`);
}
