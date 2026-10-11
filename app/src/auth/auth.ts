// The one Better Auth instance of the app: email with password (the instance admin the first-run
// setup creates, and the accounts of the later sign-up) and, when the GitHub OAuth app is configured,
// GitHub. Sessions live in our SQLite database for 30 days, and the four tables are the ones created
// by migration 20261010123800_create_auth_tables.
import "server-only";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Kysely } from "kysely";
import { getDatabase } from "../db/startup.ts";
import type { Database } from "../db/schema.ts";
import { createAllowedLoginPinsRepository } from "../db/repositories/allowed-login-pins-repository.ts";
import { loadAuthConfig, type AuthConfig } from "./config.ts";
import { membershipChecker } from "./github-org.ts";
import { githubProviderConfig } from "./github-provider.ts";
import {
  checkPassword,
  PASSWORD_ERROR_COPY,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./password-policy.ts";
import { decideSignIn, readSignInAccess } from "./sign-in-access.ts";

export const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

/** The body field that carries the new password on each Better Auth endpoint that sets one. */
const PASSWORD_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  "/sign-up/email": "password",
  "/change-password": "newPassword",
  "/set-password": "newPassword",
  "/reset-password": "newPassword",
};

export type CreateAuthOptions = {
  db: Kysely<Database>;
  config: AuthConfig;
  /** How long a call to GitHub may take. Only tests change the default. */
  githubRequestTimeoutMs?: number;
};

export function createAuth({
  db,
  config,
  githubRequestTimeoutMs,
}: CreateAuthOptions) {
  const org = config.access.org;
  const githubOAuth = config.github.oauth;
  const loginPins = createAllowedLoginPinsRepository(db);
  const checkMembership =
    org === null
      ? undefined
      : membershipChecker({
          apiBaseUrl: config.github.apiBaseUrl,
          org,
          timeoutMs: githubRequestTimeoutMs,
        });

  return betterAuth({
    appName: "Code Reviewer",
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
        // When the membership in the allowed organization was last confirmed (ISO 8601). Written
        // at sign in and by the 24 hour re-check (access-runtime.ts); read by the access policy.
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
      // The gate for who may use this instance, run by Better Auth just before it creates a user
      // or lets an existing one sign in, so a refused person leaves no user, account or session
      // behind. The decision was made by the GitHub provider from the profile and the token. It
      // fails closed: anything that is not a clear yes is a no. The `error` becomes the login
      // page's `?error=` code (see login-errors.ts).
      validateUserInfo: ({ source }) => {
        const access = readSignInAccess(source.oauth?.profile);
        if (access.allowed && source.oauth?.providerId === "github") return;
        return { error: access.allowed ? "not_allowed" : access.reason };
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
      // The user is the GitHub account (its id), never an email address. Without this, a second
      // GitHub account that reports the same verified email (the first one gave it up) would be
      // linked to the first account's user and inherit its access.
      accountLinking: { enabled: false },
      // The GitHub token is kept (the 24 hour organization re-check needs it), encrypted with the
      // secret.
      encryptOAuthTokens: true,
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
      // The password rule on every endpoint that sets a password, with a stable code.
      before: createAuthMiddleware(async (ctx) => {
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
      // GitHub sign in exists only while the GitHub OAuth app is configured.
      ...(githubOAuth === null
        ? []
        : [
            genericOAuth({
              config: [
                githubProviderConfig({
                  clientId: githubOAuth.clientId,
                  clientSecret: githubOAuth.clientSecret,
                  oauthBaseUrl: config.github.oauthBaseUrl,
                  apiBaseUrl: config.github.apiBaseUrl,
                  requestTimeoutMs: githubRequestTimeoutMs,
                  requestOrgScope: org !== null,
                  signInAccess: ({ login, githubId, accessToken }) =>
                    decideSignIn({
                      config: config.access,
                      login,
                      githubId,
                      pins: loginPins,
                      checkMembership: () =>
                        checkMembership === undefined
                          ? Promise.resolve("unavailable")
                          : checkMembership(accessToken),
                    }),
                }),
              ],
            }),
          ]),
      // Must stay the last plugin: it copies the cookies Better Auth sets into Next.js's cookie
      // store when a server action calls `auth.api`.
      nextCookies(),
    ],

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
// the proxy and the route bundles do not share modules.
const globalKey = Symbol.for("code-reviewer.auth");
type GlobalWithAuth = typeof globalThis & { [globalKey]?: Auth };

export function getAuth(): Auth {
  const holder = globalThis as GlobalWithAuth;
  holder[globalKey] ??= createAuth({
    db: getDatabase(),
    config: loadAuthConfig(process.env),
  });
  return holder[globalKey];
}
