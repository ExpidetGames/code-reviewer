// SPDX-License-Identifier: LicenseRef-Proprietary

// What the roles are called and what they mean, in the words of the pages.
import type { WorkspaceRole } from "../roles.ts";

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export const ROLE_HELP: Record<WorkspaceRole, string> = {
  member:
    "Uses the workspace: sees projects and runs, starts reviews, changes project settings.",
  admin:
    "Also manages connections, repositories and review defaults, and the Members and their invitations.",
  owner: "Also manages Admins and Owners and renames the workspace.",
};
