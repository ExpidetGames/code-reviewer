// SPDX-License-Identifier: Apache-2.0

// Linking a GitHub identity to the signed-in account (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.5 and 2.6), from the account's own page.
//
// - `start` makes the address of GitHub's authorization page: the user authorization of the instance's
//   GitHub App, with a signed, single-use state bound to the person and the session that started it, and
//   PKCE (the verifier stays on the server). Limited per person and for the instance.
// - `complete` is where GitHub sends the browser back to (the same callback address as the sign in). It
//   only goes on when the state is valid, trades the code for the user token once, reads whose GitHub
//   account that is (this is the proof of control), and then:
//     * nobody has the identity: it is linked, unless the account has another GitHub identity already;
//     * the account has it: nothing to do;
//     * another user has it: refused, except for the one case the decision record defines: the signed-in
//       instance admin and an imported user without any other credential, who are merged (merge.ts).
//   An address never links anything here: the person is signed in, and the identity is proven by GitHub.
//
// Where the browser lands afterwards is one fixed page, never an address from the request.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { secondsLeft } from "../auth/sign-in-limit.ts";
import {
  exchangeCode,
  getJson,
  GITHUB_PROVIDER_ID,
  type GithubProfile,
} from "../auth/github-provider.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { Database } from "../db/schema.ts";
import type { SignedStates } from "../signed-state/state.ts";
import { createIdentityDirectory } from "./directory.ts";
import {
  mergeImportedUser,
  type MergeErrorCode,
  type MergeOptions,
} from "./merge.ts";

/** Where the person lands after a linking: a fixed path, never an address from the request. */
export const LINK_RETURN_PAGE = "/account";

export const LINK_WINDOW_MS = 10 * 60 * 1000;
export const LINK_USER_MAX = 10;
// Only a backstop against a flood from many accounts: the allowance of each person is LINK_USER_MAX, so a few
// people cannot use up the instance's budget for everybody (it is well above what any real instance needs).
export const LINK_GLOBAL_MAX = 2000;

export function linkUserKey(userId: string): string {
  return `github-link:user:${userId}`;
}
export const LINK_GLOBAL_KEY = "github-link:all";
function linkCallbackKey(userId: string): string {
  return `github-link-callback:user:${userId}`;
}

export const LINK_ERROR_CODES = [
  /** The state is forged, expired, used, or belongs to another person or session. Nothing was exchanged. */
  "state_invalid",
  "github_not_configured",
  /** The person cancelled at GitHub. */
  "access_denied",
  /** GitHub did not accept the code. */
  "authorization_failed",
  "github_unreachable",
  /** The account is linked to another GitHub account already. */
  "already_linked",
  /** The GitHub identity belongs to another user. */
  "identity_belongs_to_other_user",
  /** The GitHub identity belongs to a user who has a password: linking is refused and nothing moves. */
  "identity_has_other_credentials",
  "rate_limited",
  "unavailable",
] as const;
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];

export type LinkOutcome = "linked" | "merged" | "already_linked";

export type LinkActor = { id: string; sessionId: string };

export type StartLinkResult =
  | { ok: true; url: string }
  | { ok: false; error: "github_not_configured" | "invalid_input" }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export type CompleteLinkResult =
  { ok: true; outcome: LinkOutcome } | { ok: false; error: LinkErrorCode };

export type GithubLinkService = {
  start(actor: LinkActor): Promise<StartLinkResult>;
  /** `query` is what GitHub put into the address of the callback. */
  complete(
    actor: LinkActor,
    query: { code: unknown; state: unknown; error: unknown },
  ): Promise<CompleteLinkResult>;
};

export type GithubLinkServiceOptions = {
  db: Kysely<Database>;
  signedStates: SignedStates;
  rateLimits: RateLimitsRepository;
  /** The user authorization of the GitHub App, or null while it is not configured. Read per call. */
  authorization: () => Promise<{
    clientId: string;
    clientSecret: string;
  } | null>;
  /** The configured public address of the app: the callback address is made from it. */
  publicUrl: string;
  /** GitHub's web address (the authorization page) and API address; the fake GitHub's in the test stack. */
  oauthBaseUrl: string;
  apiBaseUrl: string;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** Tests only: forwarded to the merge. */
  mergeHooks?: Pick<MergeOptions, "beforeCommit">;
};

const MERGE_REFUSALS: Record<MergeErrorCode, LinkErrorCode> = {
  merge_not_available: "identity_belongs_to_other_user",
  identity_belongs_to_other_user: "identity_belongs_to_other_user",
  identity_has_other_credentials: "identity_has_other_credentials",
  already_linked: "already_linked",
};

export function createGithubLinkService({
  db,
  signedStates,
  rateLimits,
  authorization,
  publicUrl,
  oauthBaseUrl,
  apiBaseUrl,
  timeoutMs = 10_000,
  now = () => new Date(),
  log = console.error,
  mergeHooks,
}: GithubLinkServiceOptions): GithubLinkService {
  const directory = createIdentityDirectory(db);
  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/api/auth/callback/github`;

  return {
    async start(actor) {
      const client = await authorization();
      if (client === null) return { ok: false, error: "github_not_configured" };

      // The instance counter first: a person over their own allowance must not use up the budget of the
      // instance (the attempt is taken back from it).
      const limited = (hit: { windowStartedAt: Date }): StartLinkResult => ({
        ok: false,
        error: "rate_limited",
        retryAfterSeconds: secondsLeft(
          hit.windowStartedAt,
          LINK_WINDOW_MS,
          now(),
        ),
      });
      const instance = await rateLimits.hit(LINK_GLOBAL_KEY, LINK_WINDOW_MS);
      if (instance.count > LINK_GLOBAL_MAX) return limited(instance);
      const own = await rateLimits.hit(linkUserKey(actor.id), LINK_WINDOW_MS);
      if (own.count > LINK_USER_MAX) {
        await rateLimits.refund(LINK_GLOBAL_KEY);
        return limited(own);
      }

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const state = await signedStates.issue({
        purpose: "github-link",
        userId: actor.id,
        sessionId: actor.sessionId,
        codeVerifier: verifier,
      });
      const url = new URL(
        `${oauthBaseUrl.replace(/\/+$/, "")}/login/oauth/authorize`,
      );
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { ok: true, url: url.toString() };
    },

    async complete(actor, query) {
      const fail = (error: LinkErrorCode): CompleteLinkResult => {
        log(`[github-link] LINK_FAILED: ${error}`);
        return { ok: false, error };
      };

      const callbacks = await rateLimits.hit(
        linkCallbackKey(actor.id),
        LINK_WINDOW_MS,
      );
      if (callbacks.count > LINK_USER_MAX) return fail("rate_limited");

      const { code, state, error } = query;
      if (typeof state !== "string" || state === "" || state.length > 2048)
        return fail("state_invalid");
      // The state first, and used up before anything else happens.
      const consumed = await signedStates.consume({
        purpose: "github-link",
        value: state,
        userId: actor.id,
        sessionId: actor.sessionId,
      });
      if (!consumed.ok) return fail("state_invalid");
      if (typeof error === "string" && error !== "")
        return fail("access_denied");
      if (typeof code !== "string" || code === "" || code.length > 512)
        return fail("authorization_failed");

      const client = await authorization();
      if (client === null) return fail("github_not_configured");

      let token: string;
      try {
        const tokens = await exchangeCode(
          { ...client, oauthBaseUrl },
          timeoutMs,
          {
            code,
            redirectURI: redirectUri,
            ...(consumed.codeVerifier === null
              ? {}
              : { codeVerifier: consumed.codeVerifier }),
          },
        );
        if (!tokens.accessToken) return fail("authorization_failed");
        token = tokens.accessToken;
      } catch {
        // The message of the failure can name a status; the cause is dropped, it can quote the request.
        return fail("authorization_failed");
      }

      // Whose GitHub account this is, by GitHub's own answer to the token we just got: the proof of control.
      const profile = await getJson<GithubProfile>(
        `${apiBaseUrl}/user`,
        token,
        timeoutMs,
      );
      if (profile === null || typeof profile.id !== "number" || !profile.login)
        return fail("github_unreachable");
      const githubId = String(profile.id);

      try {
        const owner = await directory.findByGithubId(githubId);
        if (owner?.id === actor.id)
          return { ok: true, outcome: "already_linked" };

        if (owner === null) {
          const linked = await linkNewIdentity(db, {
            userId: actor.id,
            githubId,
            login: profile.login,
            now: now(),
          });
          return linked
            ? { ok: true, outcome: "linked" }
            : fail("already_linked");
        }

        // Another user has the identity. Only the instance admin and an imported user without any other
        // credential are merged; everything else is refused with the reason.
        const merged = await mergeImportedUser(db, {
          actingUserId: actor.id,
          githubId,
          ...mergeHooks,
        });
        if (merged.ok) return { ok: true, outcome: "merged" };
        return fail(MERGE_REFUSALS[merged.error]);
      } catch {
        // The transaction rolled back (a unique index held, or the database failed): nothing changed.
        return fail("unavailable");
      }
    },
  };
}

/**
 * Links a GitHub identity nobody has to the account, unless the account has one already. The unique indexes
 * of `accounts` decide a race between two requests: the loser changes nothing and reports `false`.
 */
export async function linkNewIdentity(
  db: Kysely<Database>,
  input: { userId: string; githubId: string; login: string; now: Date },
): Promise<boolean> {
  const at = formatTimestamp(input.now);
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("accounts")
      .select("id")
      .where("user_id", "=", input.userId)
      .where("provider_id", "=", GITHUB_PROVIDER_ID)
      .executeTakeFirst();
    if (existing !== undefined) return false;
    await trx
      .insertInto("accounts")
      .values({
        id: randomUUID(),
        account_id: input.githubId,
        provider_id: GITHUB_PROVIDER_ID,
        user_id: input.userId,
        // The user token is not kept: whoever needs one later asks for a new authorization.
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: null,
        created_at: at,
        updated_at: at,
      })
      .execute();
    await trx
      .updateTable("users")
      .set({ github_login: input.login, updated_at: at })
      .where("id", "=", input.userId)
      .execute();
    return true;
  });
}
