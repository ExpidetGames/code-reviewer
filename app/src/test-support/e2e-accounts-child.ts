// SPDX-License-Identifier: Apache-2.0

// A program the Playwright journeys run (node runs this file directly, TypeScript types are stripped) to put
// a user into the database of the app under test the way the import of an existing installation leaves one:
// a user that signed in with GitHub before accounts existed, with a GitHub identity, no password, a
// placeholder address, marked as imported, and a member of the default workspace. The app is a separate
// process with the same file open (WAL), so the user shows up in the pages through the app's own reads.
//
//   import-user <db> <json>   {githubId, login, name, role}   -> {id}
//
// The first sign in with GitHub as that account then finds the user by the numeric GitHub id and replaces the
// placeholder address by the verified one (src/github-signin/decide.ts). Prints one JSON line.
import { openDatabase } from "../db/connection.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { insertUser } from "./users.ts";
import { defaultWorkspaceId } from "./workspaces.ts";

const [command, databasePath, argument] = process.argv.slice(2);
if (!command || !databasePath || !argument)
  throw new Error("Usage: e2e-accounts-child.ts <command> <db> <json>");

const db = openDatabase({
  driver: "sqlite",
  path: databasePath,
  busyTimeoutMs: 5000,
});
try {
  if (command !== "import-user") throw new Error(`Unknown command: ${command}`);
  const input = JSON.parse(argument) as {
    githubId: number;
    login: string;
    name: string;
    role: WorkspaceRole;
  };
  const id = `imported-${String(input.githubId)}`;
  await insertUser(db, {
    id,
    name: input.name,
    email: `${String(input.githubId)}@users.noreply.github.com`,
    githubLogin: input.login,
    githubId: String(input.githubId),
    importedAt: new Date().toISOString(),
  });
  const workspaces = createWorkspacesRepository(db);
  const workspaceId = await defaultWorkspaceId(db);
  await workspaces.addMember(workspaceId, id, input.role);
  console.log(JSON.stringify({ id }));
} finally {
  await db.destroy();
}
