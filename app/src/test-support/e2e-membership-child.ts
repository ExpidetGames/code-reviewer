// SPDX-License-Identifier: LicenseRef-Proprietary

// A program the Playwright journeys run (node runs this file directly, TypeScript types are stripped;
// `--conditions=react-server` lets `server-only` pass) to make an account a member of a workspace of the app
// under test, the way an import of an existing installation does (a person who signed in with GitHub before
// workspaces existed belongs to the workspace of the installation): through the real repository on the app's
// SQLite file, never by writing rows. The journeys of the invitations do not use it; they invite.
//
//   join <db> <json>   {login | email, role, workspace?}   -> {workspace, userId} (workspace: a slug; default: the oldest)
//
// Prints one JSON line.
import { openDatabase } from "../db/connection.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";

const [command, databasePath, argument] = process.argv.slice(2);
if (command !== "join" || !databasePath || !argument)
  throw new Error("Usage: e2e-membership-child.ts join <db> <json>");

const input = JSON.parse(argument) as {
  login?: string;
  email?: string;
  role: WorkspaceRole;
  workspace?: string;
};
const db = openDatabase({
  driver: "sqlite",
  path: databasePath,
  busyTimeoutMs: 5000,
});
try {
  const user = await db
    .selectFrom("users")
    .select("id")
    .where((eb) =>
      input.login !== undefined
        ? eb("github_login", "=", input.login)
        : eb("email", "=", input.email ?? ""),
    )
    .executeTakeFirst();
  if (user === undefined) throw new Error("No such account.");
  const workspaces = createWorkspacesRepository(db);
  const workspace =
    input.workspace === undefined
      ? await workspaces.findDefault()
      : await db
          .selectFrom("workspaces")
          .select(["id", "slug"])
          .where("slug", "=", input.workspace)
          .executeTakeFirst();
  if (workspace === undefined) throw new Error("No such workspace.");
  await workspaces.addMember(workspace.id, user.id, input.role);
  console.log(JSON.stringify({ workspace: workspace.slug, userId: user.id }));
} finally {
  await db.destroy();
}
