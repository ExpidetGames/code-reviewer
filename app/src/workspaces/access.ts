// SPDX-License-Identifier: Apache-2.0

// "May this request act in this workspace?", as a pure decision over what the request is signed in as
// (`SessionLookup`) and the memberships it is asked about. Every page and every data route below
// `/w/<slug>` and `/api/w/<slug>` asks it first, before anything of the workspace is read; the proxy has
// asked the membership already (src/auth/access-proxy.ts), and this is the second guard, close to the
// data, because the proxy alone must not be the only one.
//
// The workspace comes from the address and from nowhere else, and the address is never believed: the slug
// is looked up among the memberships of the person who is signed in, so a workspace they do not belong to
// is exactly as absent as one that does not exist (`not_found`). Whether they are a member of a workspace
// is not a permission: what their role allows is the second question (`forbidden`, permissions.ts).
import type { Membership } from "../db/repositories/workspaces-repository.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import type { SessionLookup } from "../auth/session-user.ts";
import { isWorkspaceSlug } from "./paths.ts";
import { can, type WorkspaceAction } from "./permissions.ts";

export type WorkspaceAccess = {
  user: SessionUser;
  workspace: Membership["workspace"];
  role: Membership["role"];
};

export type WorkspaceAccessResult =
  | { kind: "ok"; access: WorkspaceAccess }
  /** No session (or one the allow list turned away). */
  | { kind: "anonymous" }
  /** A session that has to verify the address first. */
  | { kind: "unverified" }
  /** A session of an account that belongs to no workspace, so to none of this address. */
  | { kind: "no_workspace" }
  /** The workspace is not there for this person: it does not exist or they do not belong to it. */
  | { kind: "not_found" }
  /** A member whose role does not allow the action. */
  | { kind: "forbidden"; role: Membership["role"] };

export async function resolveWorkspaceAccess({
  lookup,
  slug,
  findMembership,
  action,
}: {
  lookup: SessionLookup;
  slug: unknown;
  findMembership: (
    userId: string,
    slug: string,
  ) => Promise<Membership | undefined>;
  /** What the request needs the role for; by default viewing the workspace. */
  action?: WorkspaceAction;
}): Promise<WorkspaceAccessResult> {
  switch (lookup.kind) {
    case "none":
      return { kind: "anonymous" };
    case "unverified":
      return { kind: "unverified" };
    case "no_workspace":
      return { kind: "no_workspace" };
    case "user":
      break;
  }
  if (!isWorkspaceSlug(slug)) return { kind: "not_found" };
  const membership = await findMembership(lookup.user.id, slug);
  if (membership === undefined) return { kind: "not_found" };
  if (!can(membership.role, action ?? "view"))
    return { kind: "forbidden", role: membership.role };
  return {
    kind: "ok",
    access: {
      user: lookup.user,
      workspace: membership.workspace,
      role: membership.role,
    },
  };
}
