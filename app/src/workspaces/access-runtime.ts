// SPDX-License-Identifier: LicenseRef-Proprietary

// The access to a workspace on the running server: the session of the request and the memberships in the
// server's database, for the pages (`requireWorkspace`) and the data routes (`withWorkspace`). Both start
// from the slug in the address and ask `resolveWorkspaceAccess` (access.ts) before anything of the workspace
// is read; a service for the workspace is only made from the answer (`access.workspace.id`), so a route can
// not work on a workspace the person does not belong to. There is deliberately no "current workspace" that
// code could ask for without naming one.
import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { currentLookup } from "../auth/session.ts";
import { loginPath, type SessionLookup } from "../auth/session-user.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import {
  resolveWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspaceAccessResult,
} from "./access.ts";
import { accessRefusal } from "./access-response.ts";
import type { WorkspaceAction } from "./permissions.ts";

function resolve(
  lookup: SessionLookup,
  slug: string,
  action: WorkspaceAction,
): Promise<WorkspaceAccessResult> {
  return resolveWorkspaceAccess({
    lookup,
    slug,
    action,
    findMembership: (userId, name) =>
      createWorkspacesRepository(getDatabase()).findMembership(userId, name),
  });
}

/**
 * For a page: the workspace named by the address, for a member whose role allows `action` (by default
 * viewing). Somebody who is not signed in, has to verify the address or has no workspace is sent where
 * the proxy would send them; a workspace that is not theirs is the 404 page, and so is a page their role
 * does not allow (nothing says it is there).
 */
export const requireWorkspace = cache(
  async (
    slug: string,
    action: WorkspaceAction = "view",
  ): Promise<WorkspaceAccess> => {
    const lookup = await currentLookup();
    const result = await resolve(lookup, slug, action);
    if (result.kind === "ok") return result.access;
    if (result.kind === "not_found" || result.kind === "forbidden") notFound();
    redirect(loginPath(lookup));
  },
);

/**
 * For a data route: runs `handler` for a member whose role allows `action`, and answers the refusal of
 * access-response.ts otherwise. Called first, before anything is read, like `requireUser()`.
 */
export async function withWorkspace(
  slug: string,
  action: WorkspaceAction,
  handler: (access: WorkspaceAccess) => Promise<Response>,
): Promise<Response> {
  const result = await resolve(await currentLookup(), slug, action);
  if (result.kind !== "ok") return accessRefusal(result);
  return handler(result.access);
}

/**
 * For a data route that is not about one workspace (creating one, accepting an invitation): runs
 * `handler` for a signed in person who may be without a workspace. The person who has to verify the
 * address, or whom the allow list turned away, gets the refusals of access-response.ts.
 */
export async function withSignedIn(
  handler: (user: SessionUser) => Promise<Response>,
): Promise<Response> {
  const lookup = await currentLookup();
  switch (lookup.kind) {
    case "user":
    case "no_workspace":
      return handler(lookup.user);
    case "unverified":
      return accessRefusal({ kind: "unverified" });
    default:
      return accessRefusal({ kind: "anonymous" });
  }
}
