// SPDX-License-Identifier: Apache-2.0

// The sign in part of the fake GitHub: the OAuth authorize and token endpoints, the two profile
// endpoints Code Reviewer reads (`/user`, `/user/emails`) and the organization membership check
// (`/user/memberships/orgs/:org`). State lives in memory. Dummy values only: the tokens and codes it
// hands out are random strings without meaning outside this process.
//
// It is one part of the single fake GitHub (`server.ts`), which owns the HTTP server, the request
// log and the base URL; this file only answers the paths below.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readBody,
  readForm,
  readJson,
  redirect,
  send,
  sendHtml,
  sendJson,
} from "./http.ts";
import type { FakeInstallation } from "./app-api.ts";
import type { AppRegistry } from "./registry.ts";

export type FakeGithubUser = {
  /** GitHub's numeric account id; it stays when the login changes. */
  id: number;
  login: string;
  name: string | null;
  /** The public profile email; null when the person hides it (then `/user` answers `email: null`). */
  email: string | null;
  /** What `/user/emails` answers. Defaults to the public email as the only (primary, verified) entry. */
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
  avatarUrl?: string;
};

/**
 * The OAuth app registered for the sign in: the credentials the app under test sends. Absent when
 * only apps created through the manifest flow sign people in. Every client, this one and the apps
 * of the manifest flow, is looked up in the shared registry (`registry.ts`).
 */
export type FakeOAuthOptions = {
  clientId?: string;
  clientSecret?: string;
};

/** How the token endpoint misbehaves; `null` is normal behavior. */
export type TokenEndpointFailure =
  | { kind: "status"; status: number }
  | { kind: "delay"; delayMs: number }
  | null;

/** How the organization membership endpoint misbehaves; `null` is normal behavior. */
export type MembershipEndpointFailure =
  | { kind: "status"; status: number }
  | { kind: "delay"; delayMs: number }
  | null;

/** A membership as GitHub reports it: `pending` is an invitation that was not accepted yet. */
export type FakeMembershipState = "active" | "pending";

/**
 * The role of a member as `GET /user/memberships/orgs/:org` reports it. GitHub calls an organization owner
 * `admin` and every other member `member` (`billing_manager` exists as well).
 */
export type FakeMembershipRole = "admin" | "member" | "billing_manager";

/** What the sign in part of the fake offers a test (see `FakeGithub` in `server.ts` for the whole). */
export type FakeGithubOAuth = {
  addUser(user: FakeGithubUser): void;
  /** Changes a user in place, for example a rename: same id, new login. */
  updateUser(id: number, changes: Partial<Omit<FakeGithubUser, "id">>): void;
  failTokenEndpoint(failure: TokenEndpointFailure): void;
  /**
   * Makes `login` a member of the organization `org` (created on the way). The membership belongs
   * to the account id, so it survives a rename. Default state is `active`.
   */
  addOrgMember(
    org: string,
    login: string,
    state?: FakeMembershipState,
    role?: FakeMembershipRole,
  ): void;
  removeOrgMember(org: string, login: string): void;
  /**
   * Lets `login` see the installation `installationId` in `GET /user/installations` without being its
   * personal account or a member of its organization (an outside collaborator on one of its repositories).
   */
  grantInstallationAccess(installationId: number, login: string): void;
  /** Makes `GET /user/memberships/orgs/:org` answer an error, or answer slowly. */
  failMembershipEndpoint(failure: MembershipEndpointFailure): void;
  /**
   * Makes the role of the people in one organization unreadable for the App's user tokens (403), like an
   * organization whose owners did not accept the permission "Members" for the App. Other organizations are
   * not affected.
   */
  makeMembershipUnreadable(org: string, unreadable?: boolean): void;
  /** Revokes an access token, like the person removing the app at github.com. */
  revokeToken(accessToken: string): void;
  /**
   * Issues an access token for `login` without the browser round trip: what an installation that signed
   * people in before accounts holds in its database (the token of their last sign in). `clientId` is the
   * app the token belongs to (default: the first app the fake knows), `scope` what it was granted.
   */
  issueAccessToken(
    login: string,
    options?: { scope?: string; clientId?: string },
  ): string;
  /** Every access token issued so far; lets a test search outputs for them. */
  issuedAccessTokens(): string[];
  /**
   * Makes the next `count` requests to the token endpoint wait until `count` of them have arrived,
   * then answers them all together. Lets a test complete several sign ins at the same moment.
   */
  holdTokenRequests(count: number): void;
  /**
   * Confirms an authorize page as an account (what the "Authorize" button does) and resolves to the
   * URL the person is sent back to: the app's callback with `code` and `state`. A string is the
   * login; a number is the account id, for the case that two accounts have the same login (one of
   * them has just been renamed and GitHub has not caught up, or a test wants both at once).
   */
  authorize(authorizeUrl: string, who: string | number): Promise<URL>;
  /** What the "Cancel" button does: resolves to the callback URL with `error=access_denied`. */
  deny(authorizeUrl: string): Promise<URL>;
};

export type OAuthPart = {
  controls: FakeGithubOAuth;
  /** Answers the request when the path belongs to the sign in; false when it does not. */
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean>;
  /** Removes all users, codes and tokens; keeps the failure modes. */
  reset(): void;
  close(): void;
};

type AuthorizationCode = {
  userId: number;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string | undefined;
};

type IssuedToken = { userId: number; scope: string; clientId: string };

const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "response_type",
  "code_challenge",
  "code_challenge_method",
] as const;

/** `baseUrl` is read when a test confirms an authorize page, so it may be known after the part exists. */
export function createOAuthPart(
  _options: FakeOAuthOptions,
  baseUrl: () => string,
  registry: AppRegistry,
  /** The installations of the GitHub App part, for `GET /user/installations`. */
  installations: () => FakeInstallation[] = () => [],
): OAuthPart {
  const users = new Map<number, FakeGithubUser>();
  const codes = new Map<string, AuthorizationCode>();
  const tokens = new Map<string, IssuedToken>();
  const issued: string[] = [];
  let failure: TokenEndpointFailure = null;
  let membershipFailure: MembershipEndpointFailure = null;
  // org (lower case) -> account id -> membership
  const orgs = new Map<
    string,
    Map<number, { state: FakeMembershipState; role: FakeMembershipRole }>
  >();
  // organizations whose membership the App's user tokens cannot read (lower case)
  const unreadableOrgs = new Set<string>();
  // installation id -> account ids that see it without being its account or a member
  const installationAccess = new Map<number, Set<number>>();
  const timers = new Set<NodeJS.Timeout>();
  // Token requests that wait for the others, see `holdTokenRequests`.
  let hold: { count: number; waiting: Array<() => void> } | null = null;

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "POST" && path === "/__fake/users") {
      addUser(await readJson<FakeGithubUser>(request));
      sendJson(response, 201, { ok: true });
      return true;
    }
    if (method === "POST" && path === "/__fake/org-members") {
      const body = await readJson<{
        org: string;
        login: string;
        state?: FakeMembershipState;
        role?: FakeMembershipRole;
      }>(request);
      addOrgMember(body.org, body.login, body.state, body.role);
      sendJson(response, 201, { ok: true });
      return true;
    }
    if (method === "POST" && path === "/__fake/tokens") {
      const body = await readJson<{
        login: string;
        scope?: string;
        clientId?: string;
      }>(request);
      try {
        const token = issueAccessToken(body.login, body);
        sendJson(response, 201, { token });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "bad request",
        });
      }
      return true;
    }
    if (method === "POST" && path === "/__fake/org-unreadable") {
      const body = await readJson<{ org: string; unreadable?: boolean }>(
        request,
      );
      makeMembershipUnreadable(body.org, body.unreadable);
      sendJson(response, 201, { ok: true });
      return true;
    }
    if (method === "POST" && path === "/__fake/installation-access") {
      const body = await readJson<{ installationId: number; login: string }>(
        request,
      );
      grantInstallationAccess(body.installationId, body.login);
      sendJson(response, 201, { ok: true });
      return true;
    }
    if (method === "GET" && path === "/login/oauth/authorize") {
      renderAuthorizePage(url, response);
      return true;
    }
    if (method === "POST" && path === "/login/oauth/authorize/confirm") {
      confirmAuthorization(await readForm(request), response);
      return true;
    }
    if (method === "POST" && path === "/login/oauth/access_token") {
      await issueToken(request, response);
      return true;
    }
    // "Check a token" with the client credentials as basic authentication: the way to ask whether a
    // client id and secret belong together. Right pair: 404 for a token that does not exist (or 200
    // for one that does); wrong pair: 401.
    const checkToken = /^\/applications\/([^/]+)\/token$/.exec(path);
    if (method === "POST" && checkToken) {
      await readBody(request);
      const clientId = decodeURIComponent(checkToken[1] ?? "");
      const given = Buffer.from(
        /^Basic (.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "",
        "base64",
      ).toString("utf8");
      const client = registry.byClientId(clientId);
      if (
        client === undefined ||
        client.clientSecret === null ||
        given !== `${clientId}:${client.clientSecret}`
      )
        sendJson(response, 401, { message: "Bad credentials" });
      else sendJson(response, 404, { message: "Not Found" });
      return true;
    }
    if (method === "GET" && path === "/user") {
      sendProfile(request, response);
      return true;
    }
    if (method === "GET" && path === "/user/emails") {
      sendEmails(request, response);
      return true;
    }
    if (method === "GET" && path === "/user/installations") {
      sendUserInstallations(request, response, url);
      return true;
    }
    const membershipPath = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(path);
    if (method === "GET" && membershipPath) {
      await sendMembership(
        request,
        response,
        decodeURIComponent(membershipPath[1] ?? ""),
      );
      return true;
    }
    return false;
  }

  function renderAuthorizePage(url: URL, response: ServerResponse) {
    const params = url.searchParams;
    const app = registry.byClientId(params.get("client_id") ?? "");
    if (app === undefined)
      return sendHtml(
        response,
        404,
        "<h1>Application not found</h1><p>The client_id is not registered.</p>",
      );
    const redirectUri = params.get("redirect_uri");
    if (!redirectUri)
      return sendHtml(
        response,
        400,
        "<h1>Bad request</h1><p>redirect_uri is missing.</p>",
      );
    // Like GitHub: the address must be one of the callback URLs registered for the app.
    if (app.callbackUrls !== null && !app.callbackUrls.includes(redirectUri))
      return sendHtml(
        response,
        400,
        "<h1>Bad request</h1><p>The redirect_uri is not associated with this application.</p>",
      );

    const hidden = AUTHORIZE_PARAMS.flatMap((name) => {
      const value = params.get(name);
      return value === null
        ? []
        : [`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`];
    }).join("");
    const choices = [...users.values()]
      .map(
        (user) =>
          `<form method="post" action="/login/oauth/authorize/confirm">${hidden}` +
          `<input type="hidden" name="login" value="${escapeHtml(user.login)}">` +
          `<input type="hidden" name="account_id" value="${String(user.id)}">` +
          `<button type="submit" name="decision" value="allow">Authorize ${escapeHtml(user.login)}</button></form>`,
      )
      .join("");
    const cancel =
      `<form method="post" action="/login/oauth/authorize/confirm">${hidden}` +
      `<button type="submit" name="decision" value="deny">Cancel</button></form>`;
    sendHtml(
      response,
      200,
      `<h1>Authorize Code Reviewer</h1><p>This is a fake GitHub for tests.</p>${choices}${cancel}`,
    );
  }

  function confirmAuthorization(
    form: URLSearchParams,
    response: ServerResponse,
  ) {
    const redirectUri = form.get("redirect_uri");
    const app = registry.byClientId(form.get("client_id") ?? "");
    if (app === undefined || !redirectUri)
      return sendHtml(response, 400, "<h1>Bad request</h1>");
    if (app.callbackUrls !== null && !app.callbackUrls.includes(redirectUri))
      return sendHtml(response, 400, "<h1>Bad request</h1>");

    const callback = new URL(redirectUri);
    const state = form.get("state");
    if (state !== null) callback.searchParams.set("state", state);

    if (form.get("decision") === "deny") {
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set(
        "error_description",
        "The user has denied your application access.",
      );
      return redirect(response, callback);
    }

    const accountId = form.get("account_id");
    const user =
      accountId === null
        ? [...users.values()].find((u) => u.login === form.get("login"))
        : users.get(Number(accountId));
    if (!user) return sendHtml(response, 400, "<h1>Unknown account</h1>");

    const code = randomToken("code");
    codes.set(code, {
      userId: user.id,
      clientId: app.clientId ?? "",
      redirectUri,
      scope: form.get("scope") ?? "",
      codeChallenge:
        form.get("code_challenge_method") === "S256"
          ? (form.get("code_challenge") ?? undefined)
          : undefined,
    });
    callback.searchParams.set("code", code);
    redirect(response, callback);
  }

  async function issueToken(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const form = await readTokenRequest(request);
    await waitForHeldRequests();
    const current = failure;
    if (current?.kind === "status")
      return sendJson(response, current.status, { message: "Server Error" });
    if (current?.kind === "delay")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, current.delayMs);
        timers.add(timer);
      });
    if (response.destroyed) return;

    const wantsJson = (request.headers.accept ?? "").includes(
      "application/json",
    );
    const reply = (body: Record<string, string>) =>
      wantsJson
        ? sendJson(response, 200, body)
        : send(
            response,
            200,
            "application/x-www-form-urlencoded",
            new URLSearchParams(body).toString(),
          );

    const client = registry.byClientId(form.get("client_id") ?? "");
    if (
      client === undefined ||
      client.clientSecret === null ||
      form.get("client_secret") !== client.clientSecret
    )
      return reply({
        error: "incorrect_client_credentials",
        error_description:
          "The client_id and/or client_secret passed are incorrect.",
      });

    const code = form.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code); // A code works once.
    if (!grant || grant.clientId !== client.clientId)
      return reply({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      });
    const redirectUri = form.get("redirect_uri");
    if (redirectUri && redirectUri !== grant.redirectUri)
      return reply({
        error: "redirect_uri_mismatch",
        error_description:
          "The redirect_uri MUST match the registered callback URL for this application.",
      });
    if (grant.codeChallenge !== undefined) {
      const verifier = form.get("code_verifier") ?? "";
      const expected = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (expected !== grant.codeChallenge)
        return reply({
          error: "bad_verification_code",
          error_description: "The code_verifier does not match.",
        });
    }

    const accessToken = randomToken("gho_fake");
    tokens.set(accessToken, {
      userId: grant.userId,
      scope: grant.scope,
      clientId: grant.clientId,
    });
    issued.push(accessToken);
    reply({
      access_token: accessToken,
      scope: grant.scope.split(/[ ,]+/).filter(Boolean).join(","),
      token_type: "bearer",
    });
  }

  function waitForHeldRequests(): Promise<void> {
    const current = hold;
    if (!current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      current.waiting.push(resolve);
      if (current.waiting.length < current.count) return;
      hold = null;
      for (const release of current.waiting) release();
    });
  }

  function authenticate(
    request: IncomingMessage,
    response: ServerResponse,
  ): { user: FakeGithubUser; scope: string; clientId: string } | undefined {
    const header = request.headers.authorization ?? "";
    const accessToken = /^(?:Bearer|token) (.+)$/i.exec(header)?.[1];
    const issuedToken = accessToken ? tokens.get(accessToken) : undefined;
    const user = issuedToken ? users.get(issuedToken.userId) : undefined;
    if (!issuedToken || !user) {
      sendJson(response, 401, { message: "Bad credentials" });
      return undefined;
    }
    return { user, scope: issuedToken.scope, clientId: issuedToken.clientId };
  }

  function sendProfile(request: IncomingMessage, response: ServerResponse) {
    const auth = authenticate(request, response);
    if (!auth) return;
    const { user } = auth;
    sendJson(response, 200, {
      login: user.login,
      id: user.id,
      name: user.name,
      email: user.email,
      avatar_url:
        user.avatarUrl ?? `https://avatars.invalid/u/${String(user.id)}`,
      type: "User",
    });
  }

  function sendEmails(request: IncomingMessage, response: ServerResponse) {
    const auth = authenticate(request, response);
    if (!auth) return;
    // Like GitHub: the endpoint needs the user:email scope (an OAuth app) or, for the user token of a
    // GitHub App, the app's "Email addresses" account permission.
    const app = registry.byClientId(auth.clientId);
    const appMayRead = app?.accountPermissions.emails !== undefined;
    if (!appMayRead && !/(^|[ ,])(user:email|user)([ ,]|$)/.test(auth.scope))
      return sendJson(response, 404, { message: "Not Found" });
    const { user } = auth;
    const emails =
      user.emails ??
      (user.email
        ? [{ email: user.email, primary: true, verified: true }]
        : []);
    sendJson(
      response,
      200,
      emails.map((entry) => ({ ...entry, visibility: null })),
    );
  }

  // Like GitHub: your own membership in one organization. Needs the read:org scope (or a larger
  // one); without it GitHub answers 403. Not a member (or no such organization): 404.
  async function sendMembership(
    request: IncomingMessage,
    response: ServerResponse,
    org: string,
  ) {
    const current = membershipFailure;
    if (current?.kind === "status")
      return sendJson(response, current.status, { message: "Server Error" });
    if (current?.kind === "delay")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, current.delayMs);
        timers.add(timer);
      });
    if (response.destroyed) return;

    const auth = authenticate(request, response);
    if (!auth) return;
    // Like GitHub, every answer to an OAuth token names the scopes of the token.
    const scopes = auth.scope.split(/[ ,]+/).filter(Boolean).join(", ");
    const headers = { "x-oauth-scopes": scopes };
    // The user token of a GitHub App ignores scopes: it may read the membership when the App holds the
    // organization permission "Members" (the manifest asks for it). An OAuth token needs the read:org scope.
    const appMayRead =
      registry.byClientId(auth.clientId)?.accountPermissions.members !==
      undefined;
    if (
      !appMayRead &&
      !/(^|[ ,])(read:org|write:org|admin:org)([ ,]|$)/.test(auth.scope)
    )
      return sendJson(
        response,
        403,
        { message: "Resource not accessible by integration" },
        headers,
      );
    if (unreadableOrgs.has(org.toLowerCase()))
      return sendJson(
        response,
        403,
        { message: "Resource not accessible by integration" },
        headers,
      );
    const membership = orgs.get(org.toLowerCase())?.get(auth.user.id);
    if (!membership)
      return sendJson(response, 404, { message: "Not Found" }, headers);
    sendJson(
      response,
      200,
      {
        url: `https://api.invalid/orgs/${org}/memberships/${auth.user.login}`,
        state: membership.state,
        role: membership.role,
        organization: { login: org },
        user: { login: auth.user.login, id: auth.user.id },
      },
      headers,
    );
  }

  function addOrgMember(
    org: string,
    login: string,
    state: FakeMembershipState = "active",
    role: FakeMembershipRole = "member",
  ) {
    const user = [...users.values()].find((u) => u.login === login);
    if (!user) throw new Error(`No fake GitHub user with login ${login}`);
    const key = org.toLowerCase();
    const members =
      orgs.get(key) ??
      new Map<
        number,
        { state: FakeMembershipState; role: FakeMembershipRole }
      >();
    members.set(user.id, { state, role });
    orgs.set(key, members);
  }

  function makeMembershipUnreadable(org: string, unreadable = true) {
    if (unreadable) unreadableOrgs.add(org.toLowerCase());
    else unreadableOrgs.delete(org.toLowerCase());
  }

  function grantInstallationAccess(installationId: number, login: string) {
    const user = [...users.values()].find((u) => u.login === login);
    if (!user) throw new Error(`No fake GitHub user with login ${login}`);
    const granted = installationAccess.get(installationId) ?? new Set();
    granted.add(user.id);
    installationAccess.set(installationId, granted);
  }

  // Like GitHub: the installations of the App that the user token can reach. The user's own account, the
  // organizations they belong to (any role, once the invitation is accepted) and the ones they were granted.
  function sendUserInstallations(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    const auth = authenticate(request, response);
    if (!auth) return;
    const visible = installations().filter((installation) => {
      if (installation.account.id === auth.user.id) return true;
      const membership = orgs
        .get(installation.account.login.toLowerCase())
        ?.get(auth.user.id);
      if (membership?.state === "active") return true;
      return (
        installationAccess.get(installation.id)?.has(auth.user.id) ?? false
      );
    });
    const perPage = Math.min(
      Math.max(Number(url.searchParams.get("per_page")) || 30, 1),
      100,
    );
    const page = Math.max(Number(url.searchParams.get("page")) || 1, 1);
    sendJson(response, 200, {
      total_count: visible.length,
      installations: visible
        .slice((page - 1) * perPage, page * perPage)
        .map((installation) => ({
          id: installation.id,
          account: {
            login: installation.account.login,
            id: installation.account.id,
            type: installation.account.type,
          },
          suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
        })),
    });
  }

  function addUser(user: FakeGithubUser) {
    users.set(user.id, { ...user });
  }

  function issueAccessToken(
    login: string,
    options: { scope?: string; clientId?: string } = {},
  ): string {
    const user = [...users.values()].find((u) => u.login === login);
    if (!user) throw new Error(`No fake GitHub user with login ${login}`);
    const clientId = options.clientId ?? registry.all()[0]?.clientId ?? "";
    if (registry.byClientId(clientId) === undefined)
      throw new Error("The fake GitHub knows no such app");
    const accessToken = randomToken("gho_fake");
    tokens.set(accessToken, {
      userId: user.id,
      scope: options.scope ?? "read:user user:email read:org",
      clientId,
    });
    issued.push(accessToken);
    return accessToken;
  }

  function reset() {
    users.clear();
    codes.clear();
    tokens.clear();
    orgs.clear();
    installationAccess.clear();
    unreadableOrgs.clear();
    issued.length = 0;
  }

  async function followConfirm(
    authorizeUrl: string,
    fields: Record<string, string>,
  ): Promise<URL> {
    const params = new URL(authorizeUrl).searchParams;
    const form = new URLSearchParams();
    for (const name of AUTHORIZE_PARAMS) {
      const value = params.get(name);
      if (value !== null) form.set(name, value);
    }
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    const result = await fetch(`${baseUrl()}/login/oauth/authorize/confirm`, {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    const location = result.headers.get("location");
    if (result.status !== 302 || !location)
      throw new Error(
        `The fake GitHub did not redirect (status ${String(result.status)})`,
      );
    return new URL(location);
  }

  const controls: FakeGithubOAuth = {
    addUser,
    updateUser(id, changes) {
      const user = users.get(id);
      if (!user) throw new Error(`No fake GitHub user with id ${String(id)}`);
      users.set(id, { ...user, ...changes });
    },
    failTokenEndpoint(next) {
      failure = next;
    },
    addOrgMember,
    makeMembershipUnreadable,
    grantInstallationAccess,
    removeOrgMember(org, login) {
      const user = [...users.values()].find((u) => u.login === login);
      if (user) orgs.get(org.toLowerCase())?.delete(user.id);
    },
    failMembershipEndpoint(next) {
      membershipFailure = next;
    },
    revokeToken(accessToken) {
      tokens.delete(accessToken);
    },
    issuedAccessTokens: () => [...issued],
    issueAccessToken,
    holdTokenRequests(count) {
      hold = { count, waiting: [] };
    },
    authorize: (authorizeUrl, who) =>
      followConfirm(
        authorizeUrl,
        typeof who === "number"
          ? { account_id: String(who), decision: "allow" }
          : { login: who, decision: "allow" },
      ),
    deny: (authorizeUrl) => followConfirm(authorizeUrl, { decision: "deny" }),
  };

  return {
    controls,
    handle,
    reset,
    close() {
      hold = null;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("hex")}`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

// The token endpoint accepts a form body (what GitHub documents) or JSON.
async function readTokenRequest(
  request: IncomingMessage,
): Promise<URLSearchParams> {
  const body = await readBody(request);
  if ((request.headers["content-type"] ?? "").includes("application/json")) {
    const parsed = JSON.parse(body) as Record<string, string>;
    return new URLSearchParams(parsed);
  }
  return new URLSearchParams(body);
}
