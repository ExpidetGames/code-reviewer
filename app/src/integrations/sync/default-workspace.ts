// SPDX-License-Identifier: Apache-2.0

// The workspace a connection that is new to the instance goes to, until the installation of a connection is
// bound to the workspace of the person who installed it (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.9; its own issue). Connections that exist keep their workspace. TEMPORARY: it is
// the oldest workspace, which an installation from before workspaces has from the migration and a
// single-tenant setup made. Nothing creates a workspace here: with none, the connection waits (the sync
// reports the code, a webhook about a new installation answers 503 and can be redelivered).
import "server-only";
import type { Kysely } from "kysely";
import { createWorkspacesRepository } from "../../db/repositories/workspaces-repository.ts";
import type { Database } from "../../db/schema.ts";

export const DEFAULT_WORKSPACE_ERROR_CODES = [
  "WORKSPACE_NOT_AVAILABLE",
] as const;

/** There is no workspace to put a new connection in. */
export class NoWorkspaceForConnectionError extends Error {
  readonly code = "WORKSPACE_NOT_AVAILABLE";
  // Its message names no secret, so the synchronization may log it as it is.
  readonly safeMessage = true as const;

  constructor() {
    super(
      "The instance has no workspace yet: finish the first-run setup or create a workspace.",
    );
    this.name = "NoWorkspaceForConnectionError";
  }
}

export async function resolveDefaultWorkspaceId(
  db: Kysely<Database>,
): Promise<string> {
  const workspace = await createWorkspacesRepository(db).findDefault();
  if (workspace === undefined) throw new NoWorkspaceForConnectionError();
  return workspace.id;
}
