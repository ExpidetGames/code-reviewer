// Builds the access policy the running server uses: the allow list from the configuration, the pins
// of its logins and, in organization mode, the pieces that talk to GitHub and to Better Auth's
// tables (the stored token, the time of the last check, ending sessions). Kept apart from `access-policy.ts`, which is
// pure and tested with fakes.
import "server-only";
import { decryptOAuthToken } from "better-auth/oauth2";
import type { Kysely } from "kysely";
import { createAllowedLoginPinsRepository } from "../db/repositories/allowed-login-pins-repository.ts";
import { getDatabase } from "../db/startup.ts";
import type { Database } from "../db/schema.ts";
import {
  createAccessPolicy,
  type AccessPolicy,
  type OrgAccessDependencies,
} from "./access-policy.ts";
import { getAuth, type Auth } from "./auth.ts";
import type { AuthConfig } from "./config.ts";
import { membershipChecker } from "./github-org.ts";
import { GITHUB_PROVIDER_ID } from "./github-provider.ts";
import { loadAuthConfig } from "./config.ts";

export type AccessRuntimeOptions = {
  db: Kysely<Database>;
  auth: Pick<Auth, "$context">;
  config: Pick<AuthConfig, "access" | "github">;
  /** Only tests replace the global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** How long the check may take. Only tests change the default. */
  orgCheckTimeoutMs?: number;
};

export function createRuntimeAccessPolicy({
  db,
  auth,
  config,
  fetchImpl,
  now,
  orgCheckTimeoutMs,
}: AccessRuntimeOptions): AccessPolicy {
  const org = config.access.org;
  const checkWithToken =
    org === null
      ? undefined
      : membershipChecker({
          apiBaseUrl: config.github.apiBaseUrl,
          org,
          timeoutMs: orgCheckTimeoutMs,
          fetchImpl,
        });
  const revokeSessions = async (userId: string) => {
    const context = await auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
  };
  const orgDependencies: OrgAccessDependencies | undefined =
    org === null
      ? undefined
      : {
          async checkMembership(user) {
            const context = await auth.$context;
            const accounts = await context.internalAdapter.findAccounts(
              user.id,
            );
            const stored = accounts.find(
              (account) => account.providerId === GITHUB_PROVIDER_ID,
            )?.accessToken;
            if (!stored) return "token_invalid";
            // After the secret was rotated the stored token cannot be read any more; a new sign in
            // replaces it.
            let accessToken: string;
            try {
              // The instance type of `$context` is specific to our options; the function wants
              // the general context type. They are the same object.
              accessToken = await decryptOAuthToken(
                stored,
                context as unknown as Parameters<typeof decryptOAuthToken>[1],
              );
            } catch {
              return "token_invalid";
            }
            return checkWithToken === undefined
              ? "unavailable"
              : checkWithToken(accessToken);
          },
          async recordCheck(userId, at, orgName) {
            const context = await auth.$context;
            await context.internalAdapter.updateUser(userId, {
              orgCheckedAt: at.toISOString(),
              orgCheckedFor: orgName,
            });
          },
          revokeSessions,
        };
  return createAccessPolicy({
    config: config.access,
    loginPins: { ...createAllowedLoginPinsRepository(db), revokeSessions },
    org: orgDependencies,
    now,
  });
}

// One policy per server process (it holds the requests in flight), created on the first request and
// kept on globalThis because the proxy and the route bundles do not share modules.
const globalKey = Symbol.for("code-reviewer.access-policy");
type GlobalWithPolicy = typeof globalThis & { [globalKey]?: AccessPolicy };

export function getAccessPolicy(): AccessPolicy {
  const holder = globalThis as GlobalWithPolicy;
  holder[globalKey] ??= createRuntimeAccessPolicy({
    db: getDatabase(),
    auth: getAuth(),
    config: loadAuthConfig(process.env),
  });
  return holder[globalKey];
}
