// SPDX-License-Identifier: Apache-2.0

// Workspaces for tests. Every test database starts with no workspace (like a fresh installation), so
// a test that stores customer data asks for the default workspace first; a test about isolation adds
// a second one.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";

/** The id of the default workspace; made on the first call. */
export async function defaultWorkspaceId(
  db: Kysely<Database>,
): Promise<string> {
  return (await createWorkspacesRepository(db).ensureDefault()).id;
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
