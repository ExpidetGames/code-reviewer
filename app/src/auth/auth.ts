// SPDX-License-Identifier: LicenseRef-Proprietary

// The Better Auth instances of the app: email with password (the instance admin the first-run
// setup creates, and the accounts of the later sign-up) and, when the GitHub App has its user
// authorization configured, GitHub. Sessions live in our SQLite database for 30 days, and the four
// tables are the ones created by migration 20261010123800_create_auth_tables.
//
// The credentials of the user authorization (client id and secret) live in the database and the admin can
// replace them at any time, while Better Auth wants them when it is created. So the instance that serves
// everything but the GitHub sign in is created once (`getAuth`), and the one that serves the start of a
// GitHub sign in and its callback is created for the credentials in force (`getGithubAuth`): kept while they
// are the same, made again when they change. Both share the database and the master key, so a session made
// by one is read by the other.
import "server-only";
import { randomUUID } from "node:crypto";
import { BASE_ERROR_CODES, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Kysely } from "kysely";
import { PRODUCT_NAME } from "../copy/product-name.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import type { Database } from "../db/schema.ts";
import { loadAuthConfig, type AuthConfig } from "./config.ts";
import {
  githubProviderConfig,
  readSignInDecision,
  type GithubProviderOptions,
} from "./github-provider.ts";
import {
  checkPassword,
  PASSWORD_ERROR_COPY,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./password-policy.ts";
import { CREDENTIAL_PROVIDER_ID } from "./session-user.ts";
import {
  EMAIL_NOT_VERIFIED_CODE,
  judgeUnverifiedSignIn,
} from "./unverified-sign-in.ts";

export const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

/** The body field that carries the new password on each Better Auth endpoint that sets one. */
const PASSWORD_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  "/sign-up/email": "password",
  "/change-password": "newPassword",
  "/set-password": "newPassword",
  "/reset-password": "newPassword",
};

/** The user authorization of the GitHub App: what makes "Sign in with GitHub" work. */
export type GithubSignInOptions = {
  clientId: string;
  clientSecret: string;
  /** Who the person is, from the GitHub account and its addresses (src/github-signin/decider.ts). */
  decide: GithubProviderOptions["decide"];
};

export type CreateAuthOptions = {
  db: Kysely<Database>;
  config: AuthConfig;
  /** Left out: the sign in with GitHub does not exist on this instance of Better Auth. */
  githubSignIn?: GithubSignInOptions;
  /** How long a call to GitHub may take. Only tests change the default. */
  githubRequestTimeoutMs?: number;
  /**
   * Whether addresses must be verified: the instance can send mail. An unverified email and password
   * account is then refused at the sign in (the admin excepted, unverified-sign-in.ts). The running
   * server always passes it (`getAuth`); left out, nothing is refused here, and the gate in front of
   * every request (access-gates.ts) still keeps such an account out of the app.
   */
  verificationRequired?: () => Promise<boolean>;
};

export function createAuth({
  db,
  config,
  githubSignIn,
  githubRequestTimeoutMs,
  verificationRequired,
}: CreateAuthOptions) {
  return betterAuth({
    appName: PRODUCT_NAME,
    baseURL: config.baseUrl,
    secret: config.secret,
    database: { db, type: "sqlite", transaction: true },

    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        // The current GitHub login. It comes from the provider profile and nowhere else. Empty for
        // an account without a GitHub identity (email and password).
        githubLogin: {
          type: "string",
          required: false,
          fieldName: "github_login",
        },
        // The instance admin flag. Set by the first-run setup, never by a request.
        isInstanceAdmin: {
          type: "boolean",
          required: false,
          input: false,
          defaultValue: false,
          fieldName: "is_instance_admin",
        },
        // The GitHub address another account already has, when an imported user's placeholder address
        // could not be replaced at the sign in (src/github-signin/decide.ts); empty otherwise.
        emailConflict: {
          type: "string",
          required: false,
          fieldName: "email_conflict",
        },
        // When the membership in the allowed organization was last confirmed (ISO 8601): written by the
        // previous release's allow list, kept for the import of an existing installation.
        orgCheckedAt: {
          type: "string",
          required: false,
          fieldName: "org_checked_at",
        },
        // The organization that check was made for, so a check is never reused for another one.
        orgCheckedFor: {
          type: "string",
          required: false,
          fieldName: "org_checked_for",
        },
      },
      // The gate for who may sign in with GitHub, run by Better Auth just before it creates a user
      // or lets an existing one sign in, so a refused person leaves no user, account or session
      // behind. The decision was made by the GitHub provider from the profile and the addresses (the
      // sign-up rule is applied to the verified primary address). It fails closed: anything that is not
      // a clear yes is a no. The `error` becomes the login page's `?error=` code (see login-errors.ts).
      validateUserInfo: ({ source }) => {
        const decision = readSignInDecision(source.oauth?.profile);
        if (decision.allowed && source.oauth?.providerId === "github") return;
        return {
          error: decision.allowed ? "check_failed" : decision.reason,
        };
      },
    },
    session: {
      modelName: "sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
      expiresIn: SESSION_LIFETIME_SECONDS,
      // A session ends 30 days after the sign in, however much it is used. Extending it would have
      // to move the cookie's expiry too, and the proxy does not set cookies.
      disableSessionRefresh: true,
      // No cookie cache: every request is checked against the database, so a removed session
      // stops working at once.
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      // The user is the GitHub account (its id). A GitHub account is linked to an existing user by an
      // address only when GitHub reports that address as the verified primary one and the user's own is
      // verified too (Better Auth's default for the local side); the decision before it (the GitHub provider,
      // src/github-signin/decide.ts) refuses every other match and a user that has a GitHub account already.
      // Better Auth's own endpoints for linking and unlinking stay switched off (`disabledPaths`): linking
      // from an account's settings is ours (src/github-signin/link.ts).
      accountLinking: { enabled: true },
      // Whatever is stored is encrypted with the secret. (Nothing is: see `databaseHooks` below.)
      encryptOAuthTokens: true,
    },
    // The GitHub user token is not kept. The sign in needs it for the profile and the verified address only,
    // and nothing reads it afterwards (no organization check, no call on the person's behalf), so a database
    // copy would be a credential for nothing. Applies to a new account row and to every later sign in.
    databaseHooks: {
      account: {
        create: {
          before: (account) =>
            Promise.resolve({ data: withoutTokens(account) }),
        },
        update: {
          before: (account) =>
            Promise.resolve({ data: withoutTokens(account) }),
        },
      },
    },
    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },

    // Email with password. Nobody signs up through Better Auth: the instance admin is made by the
    // first-run setup (src/setup/), and the sign-up endpoints are not reachable (http.ts) nor
    // enabled. The password rule is the app's own (password-policy.ts); the lengths below are the
    // same bounds, there as a second line in case a path that sets a password is ever switched on.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // An unverified address does not sign in while the instance can send mail. Only after the
        // password was right (unverified-sign-in.ts); a wrong one gets Better Auth's own answer from
        // here, so that it is hashed exactly once whatever the address.
        if (
          ctx.path === "/sign-in/email" &&
          verificationRequired !== undefined
        ) {
          const body = ctx.body as Record<string, unknown> | undefined;
          const verdict =
            typeof body?.email === "string" && typeof body.password === "string"
              ? await judgeUnverifiedSignIn(
                  {
                    async findUser(email) {
                      const found =
                        await ctx.context.internalAdapter.findUserByEmail(
                          email,
                          { includeAccounts: true },
                        );
                      if (found === null) return null;
                      const credential = found.accounts.find(
                        (account) =>
                          account.providerId === CREDENTIAL_PROVIDER_ID &&
                          account.accountId === found.user.id,
                      );
                      return {
                        emailVerified: found.user.emailVerified,
                        // The adapter's type does not list our additional fields; the value is there.
                        isInstanceAdmin:
                          (found.user as { isInstanceAdmin?: unknown })
                            .isInstanceAdmin === true,
                        passwordHash: credential?.password ?? null,
                      };
                    },
                    verifyPassword: ctx.context.password.verify,
                    verificationRequired,
                  },
                  body.email,
                  body.password,
                )
              : "go_on";
          if (verdict === "not_verified")
            throw new APIError("FORBIDDEN", {
              code: EMAIL_NOT_VERIFIED_CODE,
              message: "Verify your email address to sign in.",
            });
          if (verdict === "wrong_password")
            throw APIError.from(
              "UNAUTHORIZED",
              BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD,
            );
        }

        // The password rule on every endpoint that sets a password, with a stable code.
        const field = PASSWORD_FIELD_BY_PATH[ctx.path];
        if (field === undefined) return;
        const body = ctx.body as Record<string, unknown> | undefined;
        const password = body?.[field];
        const result = checkPassword(
          typeof password === "string" ? password : "",
        );
        if (result.ok) return;
        throw new APIError("BAD_REQUEST", {
          code: result.code,
          message: PASSWORD_ERROR_COPY[result.code],
        });
      }),
    },

    plugins: [
      // GitHub sign in exists only while the GitHub App's user authorization is configured.
      ...(githubSignIn === undefined
        ? []
        : [
            genericOAuth({
              config: [
                githubProviderConfig({
                  clientId: githubSignIn.clientId,
                  clientSecret: githubSignIn.clientSecret,
                  oauthBaseUrl: config.github.oauthBaseUrl,
                  apiBaseUrl: config.github.apiBaseUrl,
                  requestTimeoutMs: githubRequestTimeoutMs,
                  decide: githubSignIn.decide,
                }),
              ],
            }),
          ]),
      // Must stay the last plugin: it copies the cookies Better Auth sets into Next.js's cookie
      // store when a server action calls `auth.api`.
      nextCookies(),
    ],

    // Better Auth's own limiter is off. It counts per client address, and an address is only as
    // trustworthy as the proxy in front of the app: a spoofable header lets a guesser start again with
    // every request, and without one every client shares a single bucket. The one endpoint where
    // guessing matters, the sign in with email and password, is limited by the app itself in the
    // shared `rate_limits` table, per email address and for the whole instance, on both the login form
    // and the HTTP endpoint (sign-in-limit.ts, http.ts). The other allowed endpoints (starting the
    // GitHub sign in, its callback, sign out) hold nothing that can be guessed.
    rateLimit: { enabled: false },

    // Only the sign in exists. Whatever could change who a user is, or add another way in, is
    // switched off: `update-user` would let a user write their own `githubLogin`, and nobody signs
    // up through Better Auth.
    disabledPaths: [
      "/sign-up/email",
      "/update-user",
      "/change-email",
      "/change-password",
      "/set-password",
      "/delete-user",
      "/link-social",
      "/unlink-account",
    ],

    advanced: {
      useSecureCookies: config.secureCookies,
      // Better Auth switches both checks off when NODE_ENV is "test". They stay on explicitly, so
      // the tests exercise what production does: only the app's own address is accepted as the
      // origin of a request and as a place to continue after a sign in.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      database: { generateId: () => randomUUID() },
    },
    // A failed sign in lands on the login page with `?error=<code>`.
    onAPIError: { errorURL: `${config.baseUrl}/login` },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// One instance per server process, created on the first request (not at import: `next build`
// imports the route modules without a database or sign-in settings). Kept on globalThis because
// the proxy and the route bundles do not share modules. This is the instance of everything but the GitHub
// sign in (see `getGithubAuth`).
const globalKey = Symbol.for("code-reviewer.auth");
type GlobalWithAuth = typeof globalThis & { [globalKey]?: Auth };

export function getAuth(): Auth {
  const holder = globalThis as GlobalWithAuth;
  holder[globalKey] ??= createAuth({
    db: getDatabase(),
    config: loadAuthConfig(process.env),
    verificationRequired: () => getMailSender().isConfigured(),
  });
  return holder[globalKey];
}

/** The fields of an account row that hold the GitHub tokens, emptied. */
function withoutTokens<T extends Record<string, unknown>>(account: T): T {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}
