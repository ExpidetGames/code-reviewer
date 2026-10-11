// "The current workspace" of a request. TEMPORARY (docs/decisions/0001-editions-setup-and-accounts.md,
// issue "Workspace data model"): until workspace switching and memberships exist, every signed-in user
// works in the default workspace, and who may sign in is still decided by the existing access policy,
// so nobody gains access. The workspaces feature replaces this function with the membership lookup;
// everything else already asks for a workspace id and does not change.
//
// The first-run setup decides whether an instance has a workspace (single-tenant: the default
// workspace is created with the admin as Owner; multi-tenant: none until somebody creates one). So
// this never creates one while the instance is not set up. It still creates the default workspace on
// first use in a set-up instance that has none (multi-tenant, before workspace creation exists), which
// the workspaces feature removes together with this file.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { getDatabase } from "../db/startup.ts";

export const WORKSPACE_ERROR_CODES = ["WORKSPACE_NOT_AVAILABLE"] as const;

/** There is no workspace and the setup, which decides whether there is one, has not run. */
export class WorkspaceUnavailableError extends Error {
  readonly code = "WORKSPACE_NOT_AVAILABLE";

  constructor() {
    super("The instance has no workspace yet: finish the first-run setup.");
    this.name = "WorkspaceUnavailableError";
  }
}

/**
 * The id of the default workspace: the oldest one (an installation from before workspaces has it from
 * the migration, a single-tenant setup made it). A database without a workspace that is not set up
 * yet gets none made here: that is the setup's decision.
 */
export async function resolveDefaultWorkspaceId(
  db: Kysely<Database>,
): Promise<string> {
  const workspaces = createWorkspacesRepository(db);
  const existing = await workspaces.findDefault();
  if (existing !== undefined) return existing.id;
  const completed =
    await createInstanceSettingsRepository(db).get("setup_completed_at");
  if (completed == null) throw new WorkspaceUnavailableError();
  return (await workspaces.ensureDefault()).id;
}

/** The id of the workspace the signed-in user works in. */
export function resolveCurrentWorkspaceId(
  db: Kysely<Database>,
): Promise<string> {
  return resolveDefaultWorkspaceId(db);
}

/** Same, on the connection of the running server. */
export function getCurrentWorkspaceId(): Promise<string> {
  return resolveCurrentWorkspaceId(getDatabase());
}
