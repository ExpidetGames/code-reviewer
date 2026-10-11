// Workspaces for tests. Every test database starts with no workspace (like a fresh installation), so
// a test that stores customer data asks for the default workspace first; a test about isolation adds
// a second one.
import type { Kysely } from "kysely";
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
