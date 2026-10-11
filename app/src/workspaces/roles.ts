// SPDX-License-Identifier: Apache-2.0

// The roles a member can have in a workspace (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.6). The database restricts the column to the same list (migration
// 20261011160000_create_workspaces); a test compares the two.
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return WORKSPACE_ROLES.some((role) => role === value);
}
