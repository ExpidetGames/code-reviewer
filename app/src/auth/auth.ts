// The one Better Auth instance of the app: GitHub is the only way in, sessions live in our SQLite
// database for 30 days, and the four tables are the ones created by migration 0002.
import "server-only";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Kysely } from "kysely";
import { getDatabase } from "../db/startup.ts";
import type { Database } from "../db/schema.ts";
import { loadAuthConfig, type AuthConfig } from "./config.ts";
import { githubProviderConfig } from "./github-provider.ts";

export const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

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
        // The current GitHub login. It comes from the provider profile and nowhere else.
        githubLogin: {
          type: "string",
          required: true,
          fieldName: "github_login",
        },
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
      // The GitHub token is kept (the access check by organization needs it later), encrypted
      // with the secret.
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

    plugins: [
      genericOAuth({
        config: [
          githubProviderConfig({
            clientId: config.github.clientId,
            clientSecret: config.github.clientSecret,
            oauthBaseUrl: config.github.oauthBaseUrl,
            apiBaseUrl: config.github.apiBaseUrl,
            requestTimeoutMs: githubRequestTimeoutMs,
          }),
        ],
      }),
      // Must stay the last plugin: it copies the cookies Better Auth sets into Next.js's cookie
      // store when a server action calls `auth.api`.
      nextCookies(),
    ],

    // Only the GitHub sign in exists. Whatever could change who a user is, or add another way in,
    // is switched off: `update-user` would let a user write their own `githubLogin`.
    disabledPaths: [
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
