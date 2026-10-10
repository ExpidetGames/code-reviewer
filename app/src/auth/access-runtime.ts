// Builds the access policy the running server uses: the allow list from the configuration plus,
// in organization mode, the pieces that talk to GitHub and to Better Auth's tables (the stored
// token, the time of the last check, ending sessions). Kept apart from `access-policy.ts`, which is
// pure and tested with fakes.
import "server-only";
import { decryptOAuthToken } from "better-auth/oauth2";
import {
  createAccessPolicy,
  type AccessPolicy,
  type OrgAccessDependencies,
} from "./access-policy.ts";
import { getAuth, type Auth } from "./auth.ts";
import type { AuthConfig } from "./config.ts";
import { checkOrgMembership } from "./github-org.ts";
import { GITHUB_PROVIDER_ID } from "./github-provider.ts";
import { loadAuthConfig } from "./config.ts";

/** A page waits for this check, so it is shorter than the one while signing in. */
const ORG_CHECK_TIMEOUT_MS = 5_000;

export type AccessRuntimeOptions = {
  auth: Pick<Auth, "$context">;
  config: Pick<AuthConfig, "access" | "github">;
  /** Only tests replace the global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export function createRuntimeAccessPolicy({
  auth,
  config,
  fetchImpl,
  now,
}: AccessRuntimeOptions): AccessPolicy {
  const org = config.access.org;
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
            // The instance type of `$context` is specific to our options; the function wants the
            // general context type. They are the same object.
            const accessToken = await decryptOAuthToken(
              stored,
              context as unknown as Parameters<typeof decryptOAuthToken>[1],
            );
            return checkOrgMembership({
              apiBaseUrl: config.github.apiBaseUrl,
              org,
              accessToken,
              timeoutMs: ORG_CHECK_TIMEOUT_MS,
              fetchImpl,
            });
          },
          async recordCheck(userId, at) {
            const context = await auth.$context;
            await context.internalAdapter.updateUser(userId, {
              orgCheckedAt: at.toISOString(),
            });
          },
          async revokeSessions(userId) {
            const context = await auth.$context;
            await context.internalAdapter.deleteUserSessions(userId);
          },
        };
  return createAccessPolicy({
    config: config.access,
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
    auth: getAuth(),
    config: loadAuthConfig(process.env),
  });
  return holder[globalKey];
}
