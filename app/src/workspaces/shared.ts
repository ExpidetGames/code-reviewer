// SPDX-License-Identifier: Apache-2.0

// The workspaces on the running server: the real database, the mail sender of the instance, the configured
// public address of the app and the shared counters. Pages and routes ask for the services here; tests build
// their own over a test database (`assembleWorkspaces`). Everything is made when it is asked for, never when
// the module is loaded, because the database is only opened once the server runs.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { githubSignInConfigured } from "../auth/sign-in-methods.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import { assembleWorkspaces, type AssembledWorkspaces } from "./assemble.ts";
import type { WorkspaceRouteHandlers } from "./http.ts";
import type { InvitationService } from "./invitations.ts";
import type { MembersService } from "./members.ts";

function assembled(): AssembledWorkspaces {
  return assembleWorkspaces({
    db: getDatabase(),
    mail: getMailSender(),
    // The address in a link is the configured one, never a request header.
    baseUrl: loadAuthConfig(process.env).baseUrl,
    githubConfigured: () => githubSignInConfigured(process.env),
  });
}

export function getMembersService(): MembersService {
  return assembled().members;
}

export function getInvitationService(): InvitationService {
  return assembled().invitations;
}

export function getWorkspaceRouteHandlers(): WorkspaceRouteHandlers {
  return assembled().handlers;
}
