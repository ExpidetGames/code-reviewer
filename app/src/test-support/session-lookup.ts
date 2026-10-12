// SPDX-License-Identifier: Apache-2.0

// A signed in person for tests of route and page files, whose session lookup is replaced (it needs the
// request scope of Next.js): the account is made in the database, joins a workspace with a role if asked,
// and the lookup it would have produced is handed back. The access to a workspace asks the membership in
// the database (src/workspaces/access-runtime.ts), so a test sets it up the way the app does.
import type { Kysely } from "kysely";
import type { SessionUser } from "../auth/access-policy.ts";
import type { SessionLookup } from "../auth/session-user.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";

export function sessionUser(
  id: string,
  overrides: Partial<SessionUser> = {},
): SessionUser {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    isInstanceAdmin: false,
    githubLogin: null,
    githubId: null,
    image: null,
    orgCheckedAt: null,
    orgCheckedFor: null,
    ...overrides,
  };
}

/** Makes the account (once) and, with a workspace, a membership with the role. */
export async function signedInMember(
  db: Kysely<Database>,
  options: {
    id?: string;
    workspaceId?: string;
    role?: WorkspaceRole;
    isInstanceAdmin?: boolean;
    githubLogin?: string;
  } = {},
): Promise<Extract<SessionLookup, { kind: "user" }>> {
  const id = options.id ?? "u1";
  const at = "2026-10-12T08:00:00.000Z";
  await db
    .insertInto("users")
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      email_verified: 1,
      image: null,
      github_login: null,
      imported_at: null,
      is_instance_admin: options.isInstanceAdmin === true ? 1 : 0,
      org_checked_at: null,
      org_checked_for: null,
      created_at: at,
      updated_at: at,
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();
  if (options.workspaceId !== undefined)
    await createWorkspacesRepository(db).addMember(
      options.workspaceId,
      id,
      options.role ?? "owner",
    );
  return {
    kind: "user",
    user: sessionUser(id, {
      isInstanceAdmin: options.isInstanceAdmin === true,
      githubLogin: options.githubLogin ?? null,
    }),
  };
}
