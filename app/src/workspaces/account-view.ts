// SPDX-License-Identifier: Apache-2.0

// What the pages around a signed in account need to know about their workspaces: which ones they belong
// to, whether they can create more, and which invitations wait for them. Read on the server for the
// switcher in the header and for the page of a person who has no workspace yet.
import "server-only";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import {
  createWorkspacesRepository,
  type Membership,
} from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { loadAcceptorFrom } from "./acceptor.ts";
import type { PendingInvitation } from "./invitations.ts";
import { getInvitationService } from "./shared.ts";

export type AccountView = {
  memberships: Membership[];
  /** Whether this instance lets people create workspaces (it is multi-tenant). */
  multiTenant: boolean;
  /** The invitations waiting for the verified address of the account (none without a mail server). */
  pending: PendingInvitation[];
  /** Whether the person is the instance admin (the portal is theirs). */
  isInstanceAdmin: boolean;
};

export async function loadAccountView(userId: string): Promise<AccountView> {
  const db = getDatabase();
  const [memberships, tenancy, acceptor] = await Promise.all([
    createWorkspacesRepository(db).listForUser(userId),
    createInstanceSettingsRepository(db).get("tenancy"),
    loadAcceptorFrom(db, userId),
  ]);
  return {
    memberships,
    multiTenant: tenancy === "multi",
    pending:
      acceptor === null
        ? []
        : await getInvitationService().listPendingFor(acceptor),
    isInstanceAdmin: acceptor?.isInstanceAdmin === true,
  };
}
