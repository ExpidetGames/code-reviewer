// SPDX-License-Identifier: Apache-2.0

// Access gates (src/auth/access-gates.ts) for tests that are about something else than the verified
// address and the workspace: nobody has to verify, and everybody belongs to a workspace.
import type { AccessGates } from "../auth/access-gates.ts";

export const openGates: AccessGates = {
  verificationRequired: () => Promise.resolve(false),
  hasWorkspace: () => Promise.resolve(true),
};
