// Creating a workspace on behalf of a user (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.3 and 2.6). Only a multi-tenant instance lets users create workspaces; a single-tenant
// instance has the one workspace its setup made. The tenancy is read in the same transaction that
// inserts the workspace, so this cannot interleave with the switch to single-tenant
// (src/admin/tenancy.ts): an instance never ends up single-tenant with two workspaces.
//
// The workspace pages (name rules, the limit of workspaces per user, renaming) come with the
// workspaces feature and call this function; it is the one place that creates a workspace for a user.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import {
  createWorkspacesRepository,
  type Workspace,
} from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";

export type CreateWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; error: "tenancy_is_single" };

export async function createWorkspaceUnderTenancy(
  db: Kysely<Database>,
  input: {
    name: string;
    slug: string;
    /** The user who creates it; becomes its Owner. */
    creatorId: string;
    now?: () => Date;
    newId?: () => string;
  },
): Promise<CreateWorkspaceResult> {
  const now = input.now ?? (() => new Date());
  return db.transaction().execute(async (trx) => {
    const tenancy = await createInstanceSettingsRepository(trx, now).get(
      "tenancy",
    );
    // No setting reads as single-tenant, like everywhere else: only multi lets users create.
    if (tenancy !== "multi")
      return { ok: false, error: "tenancy_is_single" } as const;
    const workspaces = createWorkspacesRepository(trx, now, input.newId);
    const workspace = await workspaces.create({
      name: input.name,
      slug: input.slug,
      createdBy: input.creatorId,
    });
    await workspaces.addMember(workspace.id, input.creatorId, "owner");
    return { ok: true, workspace } as const;
  });
}
