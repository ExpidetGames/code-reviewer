// SPDX-License-Identifier: Apache-2.0

// The linking of a GitHub identity on the running server: the real database, the credentials of the GitHub
// App's user authorization as the admin saved them (read per call), and the master key from the
// environment. Server code only.
import "server-only";
import { getAuth } from "../auth/auth.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getGithubCredentialStore } from "../github-config/shared.ts";
import { createSignedStates } from "../signed-state/state.ts";
import {
  createLinkCallbackHandler,
  type LinkCallbackHandlerDependencies,
} from "./link-http.ts";
import { createGithubLinkService, type GithubLinkService } from "./link.ts";

export function getGithubLinkService(): GithubLinkService {
  const db = getDatabase();
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  const config = loadAuthConfig(process.env);
  return createGithubLinkService({
    db,
    signedStates: createSignedStates({ db, appSecret: resolved.secret }),
    rateLimits: createRateLimitsRepository(db),
    authorization: async () => {
      const { userAuthorization } = await getGithubCredentialStore().load();
      return userAuthorization.state === "configured"
        ? {
            clientId: userAuthorization.clientId,
            clientSecret: userAuthorization.clientSecret.reveal(),
          }
        : null;
    },
    publicUrl: config.baseUrl,
    oauthBaseUrl: config.github.oauthBaseUrl,
    apiBaseUrl: config.github.apiBaseUrl,
  });
}

/** The person and the session of a request, from Better Auth's session lookup (the database every time). */
export const sessionOfRequest: LinkCallbackHandlerDependencies["session"] =
  async (request) => {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    return session === null
      ? null
      : { userId: session.user.id, sessionId: session.session.id };
  };

/** The callback handler of the linking: null for a request that is not one. */
export function getGithubLinkCallback(): (
  request: Request,
) => Promise<Response | null> {
  return createLinkCallbackHandler({
    session: sessionOfRequest,
    service: getGithubLinkService(),
  });
}
