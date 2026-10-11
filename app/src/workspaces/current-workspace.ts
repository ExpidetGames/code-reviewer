// "The current workspace" of a request. TEMPORARY (docs/decisions/0001-editions-setup-and-accounts.md,
// issue "Workspace data model"): until workspace switching and memberships exist, every signed-in user
// works in the default workspace, and who may sign in is still decided by the existing access policy,
// so nobody gains access. The workspaces feature replaces this function with the membership lookup;
// everything else already asks for a workspace id and does not change.
import "server-only";
import type { Kysely } from "kysely";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { getDatabase } from "../db/startup.ts";

/** The id of the workspace the signed-in user works in. */
export async function resolveCurrentWorkspaceId(
  db: Kysely<Database>,
): Promise<string> {
  return (await createWorkspacesRepository(db).ensureDefault()).id;
}

/** Same, on the connection of the running server. */
export function getCurrentWorkspaceId(): Promise<string> {
  return resolveCurrentWorkspaceId(getDatabase());
}
