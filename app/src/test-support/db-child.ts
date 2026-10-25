// SPDX-License-Identifier: LicenseRef-Proprietary

// A small program the database integration tests run as a separate OS process (node runs this file
// directly, TypeScript types are stripped): a second app instance working on the same Postgres database,
// each with a connection of its own. Protocol: one line on stdout per milestone, commands as the first argument.
//
//   migrate <url>         print "ready", wait for a line "go <epoch ms>" on stdin, spin until that
//                         moment (a start barrier: several processes begin together), then migrate the
//                         database like `pnpm migrate` does and print one JSON line:
//                         {"applied":[...]} or {"error":"CODE"}
//   set-tenancy <url> <actor id> <single|multi>
//   create-workspace <url> <creator id> <slug>
//   leave-workspace <url> <workspace id> <user id>
//                         the member leaves (src/workspaces/members.ts)
//                         each prints "ready", waits for "go <epoch ms>" like `migrate`, spins until
//                         then, runs the change on its own connection (the admin's switch of the
//                         tenancy, a user's creation of a workspace) and prints its result as one
//                         JSON line. Two of them started together race for the same rows.
import { createInterface } from "node:readline";
import { changeTenancy, type Tenancy } from "../admin/tenancy.ts";
import { DatabaseError } from "../db/errors.ts";
import { migrateToLatest } from "../db/migrate.ts";
import { openPostgresDatabase } from "../db/postgres.ts";
import { createWorkspaceUnderTenancy } from "../workspaces/create-workspace.ts";
import { createMembersService } from "../workspaces/members.ts";

const [command, databaseUrl, argument, argument2] = process.argv.slice(2);
if (!databaseUrl)
  throw new Error(
    "Usage: db-child.ts <migrate|set-tenancy|...> <database url> [...]",
  );

console.log("ready");
const lines = createInterface({ input: process.stdin });
lines.once("line", async (line) => {
  const startAt = Number(line.split(" ")[1]);
  while (Date.now() < startAt);
  const db = openPostgresDatabase({ url: databaseUrl, poolMax: 2 });
  try {
    if (command === "migrate") {
      const { executed } = await migrateToLatest(db);
      console.log(JSON.stringify({ applied: executed }));
      process.exit(0);
    }
    const result =
      command === "set-tenancy"
        ? await changeTenancy(db, {
            actorId: argument ?? "",
            tenancy: argument2 as Tenancy,
          })
        : command === "leave-workspace"
          ? await createMembersService({ db }).remove({
              workspaceId: argument ?? "",
              actorId: argument2 ?? "",
              targetUserId: argument2 ?? "",
            })
          : command === "create-workspace"
            ? await createWorkspaceUnderTenancy(db, {
                creatorId: argument ?? "",
                name: argument2 ?? "",
                slug: argument2 ?? "",
              })
            : (() => {
                throw new Error(`Unknown command: ${command ?? ""}`);
              })();
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    const code = error instanceof DatabaseError ? error.code : String(error);
    console.log(
      JSON.stringify(
        command === "migrate" ? { error: code } : { thrown: code },
      ),
    );
    process.exit(1);
  } finally {
    await db.destroy().catch(() => undefined);
  }
});
