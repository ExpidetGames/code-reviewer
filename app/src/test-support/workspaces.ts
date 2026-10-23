// SPDX-License-Identifier: Apache-2.0

// Workspaces for tests. Every test database starts with no workspace (like a fresh installation), so
// a test that stores customer data asks for the default workspace first; a test about isolation adds
// a second one.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import {
  createWorkspacesRepository,
  DEFAULT_WORKSPACE_SLUG,
} from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";

/** The id of the default workspace ("Default workspace", slug "default"); made on the first call. */
export async function defaultWorkspaceId(
  db: Kysely<Database>,
): Promise<string> {
  // Read without the repository: tests of a migration make the workspace on the schema of the release before, which has no
  // `deleted_at` yet, and a test helper must not depend on the column.
  const existing = await db
    .selectFrom("workspaces")
    .select("id")
    .orderBy("created_at")
    .orderBy("id")
    .limit(1)
    .executeTakeFirst();
  if (existing !== undefined) return existing.id;
  return (
    await createWorkspacesRepository(db).create({
      name: "Default workspace",
      slug: DEFAULT_WORKSPACE_SLUG,
      createdBy: null,
    })
  ).id;
}

/** Another workspace, for tests that need two. */
export async function addWorkspace(
  db: Kysely<Database>,
  slug: string,
): Promise<string> {
  await defaultWorkspaceId(db);
  const workspace = await createWorkspacesRepository(db).create({
    name: slug,
    slug,
    createdBy: null,
  });
  return workspace.id;
}

/**
 * Makes the database a set-up, single-tenant instance, the state a deployment is in once the
 * first-run setup has finished: the setup marker is set and the default workspace exists (without an
 * admin; tests that need one create it). A fresh test database is not set up, so code that asks "the
 * current workspace" (the synchronization of a new connection, the pages) refuses to make one until
 * a test says the instance is set up. Returns the id of the default workspace.
 */
export async function markInstanceSetUp(db: Kysely<Database>): Promise<string> {
  await createInstanceSettingsRepository(db).set(
    "setup_completed_at",
    "2026-10-11T08:00:00.000Z",
    null,
  );
  return defaultWorkspaceId(db);
}

/**
 * An installation of the GitHub App that a person of the workspace has linked: the connection as the binding
 * leaves it (src/installation-binding/connections.ts), without the round trip through GitHub. The deliveries
 * and the synchronization of an installation that is not linked do nothing; a test that is about what happens to
 * a linked one starts here.
 */
export async function linkTestInstallation(
  db: Kysely<Database>,
  workspaceId: string,
  installation: { id: string; accountLogin: string; accountId: number },
) {
  return createIntegrationsRepository(db, workspaceId).create({
    type: "github_app",
    displayName: installation.accountLogin,
    externalId: installation.id,
    config: {
      accountLogin: installation.accountLogin,
      accountId: installation.accountId,
      accountType: "Organization",
    },
  });
}

/**
 * Turns a workspace into the tombstone a deletion leaves (#658) without running the deletion: anonymised name and address and
 * the `deleted_at` mark, the data untouched. For tests of the readers that must pass a deleted workspace by.
 */
export async function markWorkspaceDeleted(
  db: Kysely<Database>,
  workspaceId: string,
  at = "2026-10-23T12:00:00.000Z",
): Promise<void> {
  await db
    .updateTable("workspaces")
    .set({
      name: "Deleted workspace",
      slug: `deleted-${workspaceId}`,
      created_by: null,
      deleted_at: at,
    })
    .where("id", "=", workspaceId)
    .execute();
}
