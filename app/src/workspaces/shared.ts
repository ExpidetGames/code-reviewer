// SPDX-License-Identifier: Apache-2.0

// The workspaces on the running server: the real database, the mail sender of the instance, the configured
// public address of the app and the shared counters. Pages and routes ask for the services here; tests build
// their own over a test database. Everything is made when it is asked for, never when the module is loaded,
// because the database is only opened once the server runs.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { githubSignInConfigured } from "../auth/sign-in-methods.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import { createWorkspaceUnderTenancy } from "./create-workspace.ts";
import {
  createWorkspaceRouteHandlers,
  type WorkspaceRouteHandlers,
} from "./http.ts";
import {
  createInvitationService,
  type InvitationService,
} from "./invitations.ts";
import { createMembersService, type MembersService } from "./members.ts";
import { createWorkspaceLimits } from "./rate-limits.ts";
import { loadAcceptorFrom } from "./acceptor.ts";

export function getMembersService(): MembersService {
  return createMembersService({ db: getDatabase() });
}

export function getInvitationService(): InvitationService {
  const db = getDatabase();
  return createInvitationService({
    db,
    mail: getMailSender(),
    limits: createWorkspaceLimits(createRateLimitsRepository(db)),
    // The address in a link is the configured one, never a request header.
    baseUrl: loadAuthConfig(process.env).baseUrl,
    githubConfigured: () => githubSignInConfigured(process.env),
  });
}

export function getWorkspaceRouteHandlers(): WorkspaceRouteHandlers {
  const db = getDatabase();
  const limits = createWorkspaceLimits(createRateLimitsRepository(db));
  return createWorkspaceRouteHandlers({
    members: getMembersService(),
    invitations: getInvitationService(),
    async createWorkspace({ name, creatorId }) {
      const permission = await limits.createWorkspace(creatorId);
      if (!permission.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: permission.retryAfterSeconds,
        };
      return createWorkspaceUnderTenancy(db, { name, creatorId });
    },
    loadAcceptor: (userId) => loadAcceptorFrom(db, userId),
  });
}
