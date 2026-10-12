// SPDX-License-Identifier: Apache-2.0

// Binding a GitHub App installation to a workspace (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.9). One GitHub App serves many workspaces and anybody may install it, so the app has to decide which
// workspace an installation belongs to without ever handing the repositories of one customer to another. The
// binding is FAIL CLOSED: whatever cannot be established links nothing.
//
// The flow, and where each step lives:
//
// 1. `startConnect`: an Owner or Admin of the workspace chooses "Connect GitHub". A signed, single-use state
//    (workspace, person, session, 10 minutes) is made and the browser goes to the App's installation page.
// 2. `completeSetup`: GitHub sends the browser back to the App's setup address with the installation id and
//    the state. The state is used up and must be the one of this person, this session and a workspace where
//    they are still Owner or Admin. The person is then sent through GitHub's user authorization, because what
//    they may do with the installation is proven by THEIR token, which is obtained now and not kept.
// 3. `completeAuthorization`: back from the authorization (a second signed state, so the code cannot be
//    replayed or aimed at another workspace). The token is exchanged, used in memory and dropped. In this order:
//    whose GitHub account it is (it becomes the person's identity, or must be the one they have), whether the
//    installation is among the ones the token can use, and whether the person is the personal account itself or
//    an owner of the organization. Access to the installation, or admin rights on a repository, never suffice.
//    If the role cannot be read, nothing is linked: a request for the instance admin is made, with the evidence.
// 4. Only then `connections.link` creates the connection and the repositories are read.
//
// The list of installations the person may link ("link an existing installation", `startPicker`,
// `chooseFromPicker`) goes through the same authorization and the same checks. Nothing here stores a GitHub
// token, logs one, or puts one in an answer; a state never carries an address, the pages redirected to are
// fixed paths (http.ts).
import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { exchangeCode } from "../auth/github-provider.ts";
import { createUnclaimedInstallationsRepository } from "../db/repositories/unclaimed-installations-repository.ts";
import { createInstallationLinkRequestsRepository } from "../db/repositories/installation-link-requests-repository.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { readGithubIdentity } from "../github-config/facts.ts";
import { createIdentityDirectory } from "../github-signin/directory.ts";
import { linkNewIdentity } from "../github-signin/link.ts";
import {
  githubAppInstallPageUrl,
  listUserInstallations,
  readOrganizationRole,
  readUser,
  type IntegrationRegistry,
  type OrganizationRole,
  type UserRequestFailure,
  type UserRequestOptions,
} from "../integrations/registry.ts";
import type { SignedStates } from "../signed-state/state.ts";
import { can } from "../workspaces/permissions.ts";
import type { Connections } from "./connections.ts";
import type { BindingErrorCode, BindingResultCode } from "./errors.ts";
import { hitBindingLimit } from "./rate-limits.ts";
import type { LinkEvidence } from "./requests.ts";

const TYPE = "github_app" as const;

/** The two facts about the GitHub App that the binding needs, read on every call. */
export type GithubFacts = {
  /** The App's URL name, for its installation page; null while there is no App. */
  slug: string | null;
  /** The user authorization of the App, or null while it is not configured. */
  userAuthorization: { clientId: string; clientSecret: string } | null;
};

export type BindingActor = { id: string; sessionId: string };

export type StartResult =
  | { ok: true; url: string }
  | { ok: false; error: BindingErrorCode; retryAfterSeconds?: number };

/** One installation of the list the person may choose from. */
export type PickerEntry = {
  installationId: string;
  accountLogin: string;
  accountType: string;
};

export type CallbackResult =
  /** Send the browser to GitHub's authorization page. */
  | { kind: "authorize"; url: string }
  /** The flow ended. `workspaceId` is null when the state could not name a workspace the person administers. */
  | {
      kind: "done";
      workspaceId: string | null;
      code: BindingResultCode;
      /** The signed value that names the list of installations (`picker_ready`). */
      picker?: string;
    };

/**
 * Whether "Connect GitHub" can be offered, and if not why (the page says it in words):
 * - `available`: the App is configured with its user authorization;
 * - `needs_approval`: single-tenant and no user authorization, so nobody's rights can be checked and the
 *   instance admin decides every request;
 * - `app_not_configured`: there is no GitHub App yet;
 * - `user_authorization_not_configured`: a multi-tenant instance without the user authorization has no Connect.
 */
export const CONNECT_AVAILABILITY = [
  "available",
  "needs_approval",
  "app_not_configured",
  "user_authorization_not_configured",
] as const;
export type ConnectAvailability = (typeof CONNECT_AVAILABILITY)[number];

export type InstallationBindingService = {
  /** What the page may offer right now. */
  availability(): Promise<{
    connect: ConnectAvailability;
    /** Whether the list of installations can be offered (it needs the user authorization). */
    picker: boolean;
  }>;
  startConnect(actor: BindingActor, workspaceId: string): Promise<StartResult>;
  startPicker(actor: BindingActor, workspaceId: string): Promise<StartResult>;
  chooseFromPicker(
    actor: BindingActor,
    workspaceId: string,
    choice: { picker: unknown; installationId: unknown },
  ): Promise<StartResult>;
  /** The installations of a list made for this person, session and workspace, or null. */
  readPicker(
    actor: BindingActor,
    workspaceId: string,
    picker: unknown,
  ): Promise<PickerEntry[] | null>;
  /** The setup address of the App: `?installation_id=&setup_action=&state=`. */
  completeSetup(
    actor: BindingActor,
    query: { installationId: unknown; setupAction: unknown; state: unknown },
  ): Promise<CallbackResult>;
  /** The callback of the user authorization, for a state of this flow. */
  completeAuthorization(
    actor: BindingActor,
    query: { code: unknown; state: unknown; error: unknown },
  ): Promise<CallbackResult>;
};

export type InstallationBindingOptions = {
  db: Kysely<Database>;
  signedStates: SignedStates;
  rateLimits: RateLimitsRepository;
  registry: IntegrationRegistry;
  connections: Connections;
  github: () => Promise<GithubFacts>;
  tenancy: () => Promise<"single" | "multi">;
  /** The configured public address of the app: the callback address is made from it, never from a header. */
  publicUrl: string;
  /** GitHub's web address (the authorization and installation pages) and API address; the fake's in the test stack. */
  oauthBaseUrl: string;
  apiBaseUrl: string;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INSTALLATION_ID = /^[1-9][0-9]{0,18}$/;

function failureCode(failure: UserRequestFailure): BindingErrorCode {
  return failure === "authorization_invalid"
    ? "github_authorization_required"
    : "github_unreachable";
}

export function createInstallationBindingService({
  db,
  signedStates,
  rateLimits,
  registry,
  connections,
  github,
  tenancy,
  publicUrl,
  oauthBaseUrl,
  apiBaseUrl,
  timeoutMs = 10_000,
  now = () => new Date(),
  log = (line) => console.error(line),
}: InstallationBindingOptions): InstallationBindingService {
  const workspaces = createWorkspacesRepository(db, now);
  const identities = createIdentityDirectory(db);
  const redirectUri = `${publicUrl.replace(/\/+$/, "")}/api/auth/callback/github`;
  const userRequest: UserRequestOptions = { apiBaseUrl, timeoutMs };

  /** Whether the person is, now, an Owner or Admin of the workspace (read from the database every time). */
  async function administers(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const membership = await workspaces.findMembershipById(userId, workspaceId);
    return (
      membership !== undefined && can(membership.role, "manage_connections")
    );
  }

  function done(
    workspaceId: string | null,
    code: BindingResultCode,
    extra: { picker?: string } = {},
  ): CallbackResult {
    if (code !== "linked" && code !== "picker_ready")
      log(`[installation-binding] BINDING_REFUSED: ${code}`);
    return { kind: "done", workspaceId, code, ...extra };
  }

  /** The address of GitHub's authorization page for a state of this flow (PKCE: the verifier stays here). */
  async function authorizeUrl(
    actor: BindingActor,
    workspaceId: string,
    client: { clientId: string },
    data: { mode: "install"; installationId: string } | { mode: "list" },
  ): Promise<string> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = await signedStates.issue({
      purpose: "github-authorize",
      userId: actor.id,
      sessionId: actor.sessionId,
      workspaceId,
      codeVerifier: verifier,
      data,
    });
    const url = new URL(
      `${oauthBaseUrl.replace(/\/+$/, "")}/login/oauth/authorize`,
    );
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async function startChecks(
    actor: BindingActor,
    workspaceId: string,
  ): Promise<
    | { ok: true }
    | { ok: false; error: BindingErrorCode; retryAfterSeconds?: number }
  > {
    if (!(await administers(actor.id, workspaceId)))
      return { ok: false, error: "workspace_role_required" };
    return { ok: true };
  }

  /** The person gets their own GitHub account's installations through the authorization of the App. */
  async function startAuthorization(
    actor: BindingActor,
    workspaceId: string,
    data: { mode: "install"; installationId: string } | { mode: "list" },
  ): Promise<StartResult> {
    const allowed = await startChecks(actor, workspaceId);
    if (!allowed.ok) return allowed;
    const facts = await github();
    if (facts.userAuthorization === null)
      return { ok: false, error: "user_authorization_not_configured" };
    const limit = await hitBindingLimit(rateLimits, "start", actor.id, now());
    if (!limit.allowed)
      return {
        ok: false,
        error: "rate_limited",
        retryAfterSeconds: limit.retryAfterSeconds,
      };
    return {
      ok: true,
      url: await authorizeUrl(
        actor,
        workspaceId,
        facts.userAuthorization,
        data,
      ),
    };
  }

  /**
   * The GitHub account that authorized becomes the person's GitHub identity, or must be the one they have. A
   * person who signed in with email only is "sent through GitHub first": no second user is made, the identity
   * is attached to this one, unless it belongs to somebody else.
   */
  async function attachIdentity(
    userId: string,
    profile: { id: number; login: string },
  ): Promise<"ok" | BindingErrorCode> {
    const githubId = String(profile.id);
    const existing = await readGithubIdentity(db, userId);
    if (existing !== null)
      return existing.githubId === githubId ? "ok" : "github_identity_mismatch";
    const owner = await identities.findByGithubId(githubId);
    if (owner !== null && owner.id !== userId)
      return "identity_belongs_to_other_user";
    try {
      return (await linkNewIdentity(db, {
        userId,
        githubId,
        login: profile.login,
        now: now(),
      }))
        ? "ok"
        : "github_identity_mismatch";
    } catch {
      // A unique index held: somebody has the identity now. Nothing changed.
      return "identity_belongs_to_other_user";
    }
  }

  /** Whether an installation that this workspace may not take is linked to another workspace. */
  async function linkedElsewhereOrHere(
    workspaceId: string,
    installationId: string,
  ): Promise<"elsewhere" | "here" | "disconnected_here" | "none"> {
    const row = await db
      .selectFrom("integrations")
      .select(["workspace_id", "status"])
      .where("type", "=", TYPE)
      .where("external_id", "=", installationId)
      .executeTakeFirst();
    if (row === undefined) return "none";
    if (row.workspace_id !== workspaceId) return "elsewhere";
    return row.status === "disconnected" ? "disconnected_here" : "here";
  }

  async function link(
    workspaceId: string,
    installationId: string,
  ): Promise<CallbackResult> {
    const linked = await connections.link({ workspaceId, installationId });
    if (linked.ok) return done(workspaceId, "linked");
    if (linked.error === "not_claimed") return done(workspaceId, "unavailable");
    return done(workspaceId, linked.error);
  }

  async function requestApproval(
    workspaceId: string,
    userId: string,
    installation: {
      id: string;
      accountLogin: string;
      accountType: string;
      accountId: number | string;
    },
    requesterLogin: string | null,
    evidence: LinkEvidence,
  ): Promise<CallbackResult> {
    const state = await linkedElsewhereOrHere(workspaceId, installation.id);
    if (state === "elsewhere")
      return done(workspaceId, "installation_already_linked");
    if (state === "here") return done(workspaceId, "linked");
    await createInstallationLinkRequestsRepository(
      db,
      workspaceId,
      now,
    ).createPending({
      requestedBy: userId,
      requesterGithubLogin: requesterLogin,
      installationId: installation.id,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      accountId: String(installation.accountId),
      evidence,
    });
    return done(workspaceId, "waiting_for_instance_admin");
  }

  /** Checks 3 and 4: the installation is among the person's, and they own or administer its account. */
  async function bind(
    workspaceId: string,
    userId: string,
    token: string,
    profile: { id: number; login: string },
    installationId: string,
  ): Promise<CallbackResult> {
    const listed = await listUserInstallations(userRequest, token);
    if (!listed.ok) return done(workspaceId, failureCode(listed.error));
    const found = listed.installations.find(
      (installation) => installation.id === installationId,
    );
    if (found === undefined)
      return done(workspaceId, "installation_not_accessible");

    let role: OrganizationRole;
    if (found.accountType === "User") {
      // The personal account itself, and nobody else who happens to see it.
      role =
        found.accountId === profile.id ? { kind: "admin" } : { kind: "member" };
    } else if (found.accountType === "Organization") {
      const read = await readOrganizationRole(
        userRequest,
        token,
        found.accountLogin,
      );
      if (!read.ok) return done(workspaceId, failureCode(read.error));
      role = read.role;
    } else {
      role = { kind: "member" };
    }

    if (role.kind === "admin") return link(workspaceId, installationId);
    if (role.kind === "member" || role.kind === "not_a_member")
      return done(workspaceId, "not_installation_admin");
    // The role cannot be read: nothing is linked, the instance admin decides.
    return requestApproval(workspaceId, userId, found, profile.login, {
      tokenCanAccess: true,
      roleResult: "unreadable",
      roleDetail: role.detail,
    });
  }

  /** The list of installations the person's token can use and that no other workspace has linked. */
  async function list(
    actor: BindingActor,
    workspaceId: string,
    token: string,
  ): Promise<CallbackResult> {
    const listed = await listUserInstallations(userRequest, token);
    if (!listed.ok) return done(workspaceId, failureCode(listed.error));
    const entries: PickerEntry[] = [];
    for (const installation of listed.installations) {
      const where = await linkedElsewhereOrHere(workspaceId, installation.id);
      // One that is linked is not offered (the person's own workspace may have ended it: that one is).
      if (where === "elsewhere" || where === "here") continue;
      entries.push({
        installationId: installation.id,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
      });
    }
    const picker = await signedStates.issue({
      purpose: "github-picker",
      userId: actor.id,
      sessionId: actor.sessionId,
      workspaceId,
      data: { installations: entries },
    });
    return done(workspaceId, "picker_ready", { picker });
  }

  function readEntries(data: unknown): PickerEntry[] | null {
    if (!isObject(data) || !Array.isArray(data.installations)) return null;
    const entries: PickerEntry[] = [];
    for (const item of data.installations) {
      if (
        !isObject(item) ||
        typeof item.installationId !== "string" ||
        typeof item.accountLogin !== "string" ||
        typeof item.accountType !== "string"
      )
        return null;
      entries.push({
        installationId: item.installationId,
        accountLogin: item.accountLogin,
        accountType: item.accountType,
      });
    }
    return entries;
  }

  async function peekPicker(
    actor: BindingActor,
    workspaceId: string,
    picker: unknown,
  ): Promise<PickerEntry[] | null> {
    if (typeof picker !== "string" || picker === "" || picker.length > 4096)
      return null;
    const peeked = await signedStates.peek({
      purpose: "github-picker",
      value: picker,
      userId: actor.id,
      sessionId: actor.sessionId,
    });
    if (!peeked.ok || peeked.workspaceId !== workspaceId) return null;
    return readEntries(peeked.data);
  }

  return {
    async availability() {
      const facts = await github();
      if (facts.slug === null)
        return { connect: "app_not_configured", picker: false };
      if (facts.userAuthorization !== null)
        return { connect: "available", picker: true };
      return {
        connect:
          (await tenancy()) === "multi"
            ? "user_authorization_not_configured"
            : "needs_approval",
        picker: false,
      };
    },

    async startConnect(actor, workspaceId) {
      const allowed = await startChecks(actor, workspaceId);
      if (!allowed.ok) return allowed;
      const facts = await github();
      if (facts.slug === null)
        return { ok: false, error: "github_app_not_configured" };
      // Without the user authorization nobody's rights can be checked. A multi-tenant instance then has no
      // Connect at all; a single-tenant one lets its instance admin decide (the request, below).
      if (facts.userAuthorization === null && (await tenancy()) === "multi")
        return { ok: false, error: "user_authorization_not_configured" };
      const page = githubAppInstallPageUrl(oauthBaseUrl, facts.slug);
      if (page === null)
        return { ok: false, error: "github_app_not_configured" };
      const limit = await hitBindingLimit(rateLimits, "start", actor.id, now());
      if (!limit.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: limit.retryAfterSeconds,
        };
      const state = await signedStates.issue({
        purpose: "github-install",
        userId: actor.id,
        sessionId: actor.sessionId,
        workspaceId,
      });
      const url = new URL(page);
      url.searchParams.set("state", state);
      return { ok: true, url: url.toString() };
    },

    startPicker(actor, workspaceId) {
      return startAuthorization(actor, workspaceId, { mode: "list" });
    },

    async chooseFromPicker(actor, workspaceId, choice) {
      const allowed = await startChecks(actor, workspaceId);
      if (!allowed.ok) return allowed;
      const entries = await peekPicker(actor, workspaceId, choice.picker);
      const chosen =
        typeof choice.installationId === "string"
          ? choice.installationId
          : null;
      if (
        entries === null ||
        chosen === null ||
        !entries.some((entry) => entry.installationId === chosen)
      )
        return { ok: false, error: "picker_invalid" };
      return startAuthorization(actor, workspaceId, {
        mode: "install",
        installationId: chosen,
      });
    },

    readPicker: peekPicker,

    async completeSetup(actor, query) {
      const limit = await hitBindingLimit(
        rateLimits,
        "callback",
        actor.id,
        now(),
      );
      if (!limit.allowed) return done(null, "rate_limited");

      const { installationId, setupAction, state } = query;
      if (typeof state !== "string" || state === "" || state.length > 4096)
        return done(null, "state_invalid");
      // The state first, and used up before anything else happens: only the person, the session and the purpose
      // it was made for can use it, once.
      const consumed = await signedStates.consume({
        purpose: "github-install",
        value: state,
        userId: actor.id,
        sessionId: actor.sessionId,
      });
      if (!consumed.ok || consumed.workspaceId === null)
        return done(null, "state_invalid");
      const workspaceId = consumed.workspaceId;
      if (!(await administers(actor.id, workspaceId)))
        return done(null, "workspace_role_required");

      // GitHub asked the owners of the account to approve the installation: nothing exists to link yet.
      if (setupAction === "request")
        return done(workspaceId, "waiting_for_github_approval");
      if (
        typeof installationId !== "string" ||
        !INSTALLATION_ID.test(installationId)
      )
        return done(workspaceId, "installation_id_invalid");

      const facts = await github();
      if (facts.userAuthorization === null) {
        if ((await tenancy()) === "multi")
          return done(workspaceId, "user_authorization_not_configured");
        return requestWithoutToken(actor.id, workspaceId, installationId);
      }
      return {
        kind: "authorize",
        url: await authorizeUrl(actor, workspaceId, facts.userAuthorization, {
          mode: "install",
          installationId,
        }),
      };
    },

    async completeAuthorization(actor, query) {
      const limit = await hitBindingLimit(
        rateLimits,
        "callback",
        actor.id,
        now(),
      );
      if (!limit.allowed) return done(null, "rate_limited");

      const { code, state, error } = query;
      if (typeof state !== "string" || state === "" || state.length > 4096)
        return done(null, "state_invalid");
      const consumed = await signedStates.consume({
        purpose: "github-authorize",
        value: state,
        userId: actor.id,
        sessionId: actor.sessionId,
      });
      if (!consumed.ok || consumed.workspaceId === null)
        return done(null, "state_invalid");
      const workspaceId = consumed.workspaceId;
      // Still an Owner or Admin of that workspace, now.
      if (!(await administers(actor.id, workspaceId)))
        return done(null, "workspace_role_required");
      const data = consumed.data;
      const mode = isObject(data) ? data.mode : undefined;
      const installationId = isObject(data) ? data.installationId : undefined;
      if (
        mode !== "list" &&
        !(mode === "install" && typeof installationId === "string")
      )
        return done(workspaceId, "state_invalid");

      if (typeof error === "string" && error !== "")
        return done(workspaceId, "access_denied");
      if (typeof code !== "string" || code === "" || code.length > 512)
        return done(workspaceId, "github_authorization_required");
      const facts = await github();
      if (facts.userAuthorization === null)
        return done(workspaceId, "user_authorization_not_configured");

      // From here the person's token exists, in this variable and nowhere else: it is used for the checks below
      // and dropped when the call ends. It is never stored, logged or returned.
      let token: string;
      try {
        const tokens = await exchangeCode(
          {
            clientId: facts.userAuthorization.clientId,
            clientSecret: facts.userAuthorization.clientSecret,
            oauthBaseUrl,
          },
          timeoutMs,
          {
            code,
            redirectURI: redirectUri,
            ...(consumed.codeVerifier === null
              ? {}
              : { codeVerifier: consumed.codeVerifier }),
          },
        );
        if (!tokens.accessToken)
          return done(workspaceId, "github_authorization_required");
        token = tokens.accessToken;
      } catch (failure) {
        // A refused code is the person's to repeat; a GitHub that does not answer is not. (The message names
        // a status or GitHub's error code, never the code, the secret or a token.)
        const message = failure instanceof Error ? failure.message : "";
        return done(
          workspaceId,
          /did not issue an access token|status 4\d\d/.test(message)
            ? "github_authorization_required"
            : "github_unreachable",
        );
      }

      const who = await readUser(userRequest, token);
      if (!who.ok) return done(workspaceId, failureCode(who.error));
      const identity = await attachIdentity(actor.id, who.user);
      if (identity !== "ok") return done(workspaceId, identity);

      if (mode === "list") return list(actor, workspaceId, token);
      return bind(
        workspaceId,
        actor.id,
        token,
        who.user,
        installationId as string,
      );
    },
  };

  /**
   * A single-tenant instance whose App has no user authorization cannot check anybody's rights with a token.
   * The installation is then described by GitHub to the App itself, and the instance admin decides.
   *
   * Nothing proves that the person may use the installation, so the id they bring must not be a probe: only an
   * installation the instance has noted as unclaimed (it arrived by delivery or by the synchronization) can be
   * asked for. Every other id, one GitHub does not know, one that does not exist and one that belongs to
   * another workspace, gets the same answer, and the App is not asked about it at all.
   */
  async function requestWithoutToken(
    userId: string,
    workspaceId: string,
    installationId: string,
  ): Promise<CallbackResult> {
    const where = await linkedElsewhereOrHere(workspaceId, installationId);
    if (where === "here") return done(workspaceId, "linked");
    if (
      where === "elsewhere" ||
      (where === "none" &&
        (await createUnclaimedInstallationsRepository(db, now).get(
          installationId,
        )) === undefined)
    )
      return done(workspaceId, "installation_not_accessible");
    let connection;
    try {
      connection = await registry
        .resolve(TYPE)
        .findConnection?.(installationId);
    } catch {
      return done(workspaceId, "github_unreachable");
    }
    if (connection === undefined || connection === null)
      return done(workspaceId, "installation_not_accessible");
    const accountId = connection.config.accountId;
    const accountType = connection.config.accountType;
    return requestApproval(
      workspaceId,
      userId,
      {
        id: installationId,
        accountLogin: connection.displayName,
        accountType: typeof accountType === "string" ? accountType : "",
        accountId: typeof accountId === "number" ? accountId : "",
      },
      null,
      {
        tokenCanAccess: null,
        roleResult: "unavailable",
        roleDetail: "user_authorization_not_configured",
      },
    );
  }
}
