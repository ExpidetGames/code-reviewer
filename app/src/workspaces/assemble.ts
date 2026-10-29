// SPDX-License-Identifier: LicenseRef-Proprietary

// Puts the route handlers of the workspaces together over one database, one mail sender and one set of
// counters. The running server (`shared.ts`) and the integration tests (`src/test-support/workspace-
// harness.ts`) both build their handlers here, so a test runs the code that serves requests.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { MailSender } from "../mail/sender.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { loadAcceptorFrom } from "./acceptor.ts";
import { createWorkspaceUnderTenancy } from "./create-workspace.ts";
import {
  createWorkspaceRouteHandlers,
  type WorkspaceRouteHandlers,
} from "./http.ts";
import {
  createInvitationService,
  type InvitationService,
} from "./invitations.ts";
import { createWorkspaceDeletion } from "./delete-workspace.ts";
import type { CheckFinisher } from "./finish-checks.ts";
import { createMembersService, type MembersService } from "./members.ts";
import { createWorkspaceLimits, type WorkspaceLimits } from "./rate-limits.ts";

export type AssembleWorkspacesOptions = {
  db: Kysely<Database>;
  mail: MailSender;
  /** The configured public address of the app: a link never comes from a request header. */
  baseUrl: string;
  /** Whose name the invitation mail carries. */
  product: ProductIdentity;
  /** Whether sign-in with GitHub exists (a fact of the sign-up rule). */
  githubConfigured: () => boolean | Promise<boolean>;
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
  log?: (message: string) => void;
  /** Completes the check runs of the reviews a deleted workspace had waiting; the running server passes the GitHub one. */
  finishChecks?: CheckFinisher;
};

export type AssembledWorkspaces = {
  members: MembersService;
  invitations: InvitationService;
  limits: WorkspaceLimits;
  handlers: WorkspaceRouteHandlers;
};

export function assembleWorkspaces(
  options: AssembleWorkspacesOptions,
): AssembledWorkspaces {
  const { db, now } = options;
  const limits = createWorkspaceLimits(
    createRateLimitsRepository(db, now),
    now,
  );
  const members = createMembersService({ db, now });
  const invitations = createInvitationService({
    db,
    mail: options.mail,
    limits,
    baseUrl: options.baseUrl,
    product: options.product,
    githubConfigured: options.githubConfigured,
    now,
    newId: options.newId,
    newToken: options.newToken,
    log: options.log,
  });
  const handlers = createWorkspaceRouteHandlers({
    members,
    invitations,
    deletion: createWorkspaceDeletion({
      db,
      now,
      log: options.log,
      finishChecks: options.finishChecks,
    }),
    async createWorkspace({ name, creatorId }) {
      const permission = await limits.createWorkspace(creatorId);
      if (!permission.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: permission.retryAfterSeconds,
        };
      return createWorkspaceUnderTenancy(db, { name, creatorId, now });
    },
    loadAcceptor: (userId) => loadAcceptorFrom(db, userId),
  });
  return { members, invitations, limits, handlers };
}
