// SPDX-License-Identifier: Apache-2.0

// Access gates (src/auth/access-gates.ts) for tests that are about something else than the verified
// address and the workspace: nobody has to verify, and everybody belongs to a workspace.
import type { AccessGates } from "../auth/access-gates.ts";

export const openGates: AccessGates = {
  verificationRequired: () => Promise.resolve(false),
  hasWorkspace: () => Promise.resolve(true),
  workspaceRole: () => Promise.resolve("owner"),
  firstWorkspaceSlug: () => Promise.resolve("default"),
};

/** The gates of a person who belongs to no workspace (an account the sign-up or the sign in made, not yet invited). */
export const noWorkspaceGates: AccessGates = {
  verificationRequired: () => Promise.resolve(false),
  hasWorkspace: () => Promise.resolve(false),
  workspaceRole: () => Promise.resolve(null),
  firstWorkspaceSlug: () => Promise.resolve(null),
};
