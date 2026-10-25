// SPDX-License-Identifier: LicenseRef-Proprietary

// The access gates of the running server: whether the instance can send mail (looked up on every call,
// because the admin can add or remove the mail server at any time) and whether the user belongs to a
// workspace, both from the server's database.
import "server-only";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import type { AccessGates } from "./access-gates.ts";

export function getAccessGates(): AccessGates {
  // The database is opened when a gate is asked, not when the gates are handed out.
  return {
    verificationRequired: () => getMailSender().isConfigured(),
    hasWorkspace: (userId) =>
      createWorkspacesRepository(getDatabase()).hasMembership(userId),
    async workspaceRole(userId, slug) {
      const membership = await createWorkspacesRepository(
        getDatabase(),
      ).findMembership(userId, slug);
      return membership?.role ?? null;
    },
    async firstWorkspaceSlug(userId) {
      const [first] =
        await createWorkspacesRepository(getDatabase()).listForUser(userId);
      return first?.workspace.slug ?? null;
    },
  };
}
