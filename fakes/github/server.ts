// A fake GitHub for the sign in: the OAuth authorize and token endpoints, the two profile
// endpoints Code Reviewer reads (`/user`, `/user/emails`) and the organization membership check
// (`/user/memberships/orgs/:org`). It is a real HTTP server speaking
// GitHub's protocol, so the production code runs unchanged against it; only the base URL differs.
// State lives in memory. Dummy values only: the tokens and codes it hands out are random strings
// without meaning outside this process.
//
// Runs in the same process as a Vitest test (`startGithubFake`) or as its own process for the
// Playwright journeys (`main.ts`, which also exposes the control endpoints below over HTTP).
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

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

export type FakeGithubOptions = {
  clientId: string;
  clientSecret: string;
  /** Default 127.0.0.1. */
  host?: string;
  /** Default 0: a free port. */
  port?: number;
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

export type FakeGithubRequest = { method: string; path: string };

export type FakeGithub = {
  /** For example http://127.0.0.1:41234; serves both the OAuth pages and the API. */
  baseUrl: string;
  addUser(user: FakeGithubUser): void;
  /** Changes a user in place, for example a rename: same id, new login. */
  updateUser(id: number, changes: Partial<Omit<FakeGithubUser, "id">>): void;
  /** Removes all users, codes, tokens and recorded requests; keeps the failure mode. */
  reset(): void;
  failTokenEndpoint(failure: TokenEndpointFailure): void;
  /**
   * Makes `login` a member of the organization `org` (created on the way). The membership belongs
   * to the account id, so it survives a rename. Default state is `active`.
   */
  addOrgMember(org: string, login: string, state?: FakeMembershipState): void;
  removeOrgMember(org: string, login: string): void;
  /** Makes `GET /user/memberships/orgs/:org` answer an error, or answer slowly. */
  failMembershipEndpoint(failure: MembershipEndpointFailure): void;
  /** Revokes an access token, like the person removing the app at github.com. */
  revokeToken(accessToken: string): void;
  /** Every request received, in order (no headers, no bodies, no tokens). */
  requests(): FakeGithubRequest[];
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
  close(): Promise<void>;
};

type AuthorizationCode = {
  userId: number;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string | undefined;
};

type IssuedToken = { userId: number; scope: string };

const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "response_type",
  "code_challenge",
  "code_challenge_method",
] as const;

export async function startGithubFake(
  options: FakeGithubOptions,
): Promise<FakeGithub> {
  const users = new Map<number, FakeGithubUser>();
  const codes = new Map<string, AuthorizationCode>();
  const tokens = new Map<string, IssuedToken>();
  const issued: string[] = [];
  let requests: FakeGithubRequest[] = [];
  let failure: TokenEndpointFailure = null;
  let membershipFailure: MembershipEndpointFailure = null;
  // org (lower case) -> account id -> state
  const orgs = new Map<string, Map<number, FakeMembershipState>>();
  const timers = new Set<NodeJS.Timeout>();
  // Token requests that wait for the others, see `holdTokenRequests`.
  let hold: { count: number; waiting: Array<() => void> } | null = null;

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, {
        message: `fake github failed: ${String(error)}`,
      });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const method = request.method ?? "GET";
    requests.push({ method, path: url.pathname });

    if (method === "GET" && url.pathname === "/__fake/health")
      return sendJson(response, 200, { ok: true });
    if (method === "POST" && url.pathname === "/__fake/users") {
      addUser(await readJson<FakeGithubUser>(request));
      return sendJson(response, 201, { ok: true });
    }
    if (method === "POST" && url.pathname === "/__fake/org-members") {
      const body = await readJson<{
        org: string;
        login: string;
        state?: FakeMembershipState;
      }>(request);
      addOrgMember(body.org, body.login, body.state);
      return sendJson(response, 201, { ok: true });
    }
    if (method === "POST" && url.pathname === "/__fake/reset") {
      reset();
      return sendJson(response, 200, { ok: true });
    }
    if (method === "GET" && url.pathname === "/login/oauth/authorize")
      return renderAuthorizePage(url, response);
    if (method === "POST" && url.pathname === "/login/oauth/authorize/confirm")
      return confirmAuthorization(await readForm(request), response);
    if (method === "POST" && url.pathname === "/login/oauth/access_token")
      return issueToken(request, response);
    if (method === "GET" && url.pathname === "/user")
      return sendProfile(request, response);
    if (method === "GET" && url.pathname === "/user/emails")
      return sendEmails(request, response);
    const membershipPath = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(
      url.pathname,
    );
    if (method === "GET" && membershipPath)
      return sendMembership(
        request,
        response,
        decodeURIComponent(membershipPath[1] ?? ""),
      );

    sendJson(response, 404, { message: "Not Found" });
  }

  function renderAuthorizePage(url: URL, response: ServerResponse) {
    const params = url.searchParams;
    if (params.get("client_id") !== options.clientId)
      return sendHtml(
        response,
        404,
        "<h1>Application not found</h1><p>The client_id is not registered.</p>",
      );
    if (!params.get("redirect_uri"))
      return sendHtml(
        response,
        400,
        "<h1>Bad request</h1><p>redirect_uri is missing.</p>",
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
    if (form.get("client_id") !== options.clientId || !redirectUri)
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
      clientId: options.clientId,
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

    if (
      form.get("client_id") !== options.clientId ||
      form.get("client_secret") !== options.clientSecret
    )
      return reply({
        error: "incorrect_client_credentials",
        error_description:
          "The client_id and/or client_secret passed are incorrect.",
      });

    const code = form.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code); // A code works once.
    if (!grant || grant.clientId !== options.clientId)
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
    tokens.set(accessToken, { userId: grant.userId, scope: grant.scope });
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
  ): { user: FakeGithubUser; scope: string } | undefined {
    const header = request.headers.authorization ?? "";
    const accessToken = /^(?:Bearer|token) (.+)$/i.exec(header)?.[1];
    const issuedToken = accessToken ? tokens.get(accessToken) : undefined;
    const user = issuedToken ? users.get(issuedToken.userId) : undefined;
    if (!issuedToken || !user) {
      sendJson(response, 401, { message: "Bad credentials" });
      return undefined;
    }
    return { user, scope: issuedToken.scope };
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
    // Like GitHub: the endpoint needs the user:email scope.
    if (!/(^|[ ,])(user:email|user)([ ,]|$)/.test(auth.scope))
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
    if (!/(^|[ ,])(read:org|write:org|admin:org)([ ,]|$)/.test(auth.scope))
      return sendJson(
        response,
        403,
        { message: "Resource not accessible by personal access token" },
        headers,
      );
    const state = orgs.get(org.toLowerCase())?.get(auth.user.id);
    if (!state)
      return sendJson(response, 404, { message: "Not Found" }, headers);
    sendJson(
      response,
      200,
      {
        url: `https://api.invalid/orgs/${org}/memberships/${auth.user.login}`,
        state,
        role: "member",
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
  ) {
    const user = [...users.values()].find((u) => u.login === login);
    if (!user) throw new Error(`No fake GitHub user with login ${login}`);
    const key = org.toLowerCase();
    const members = orgs.get(key) ?? new Map<number, FakeMembershipState>();
    members.set(user.id, state);
    orgs.set(key, members);
  }

  function addUser(user: FakeGithubUser) {
    users.set(user.id, { ...user });
  }

  function reset() {
    users.clear();
    codes.clear();
    tokens.clear();
    orgs.clear();
    issued.length = 0;
    requests = [];
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${String(address.port)}`;

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
    const result = await fetch(`${baseUrl}/login/oauth/authorize/confirm`, {
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

  return {
    baseUrl,
    addUser,
    updateUser(id, changes) {
      const user = users.get(id);
      if (!user) throw new Error(`No fake GitHub user with id ${String(id)}`);
      users.set(id, { ...user, ...changes });
    },
    reset,
    failTokenEndpoint(next) {
      failure = next;
    },
    addOrgMember,
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
    requests: () => [...requests],
    issuedAccessTokens: () => [...issued],
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
    async close() {
      hold = null;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
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

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "content-type": contentType, ...headers });
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  send(response, status, "application/json", JSON.stringify(body), headers);
}

function sendHtml(response: ServerResponse, status: number, body: string) {
  send(
    response,
    status,
    "text/html; charset=utf-8",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake GitHub</title></head><body>${body}</body></html>`,
  );
}

function redirect(response: ServerResponse, location: URL) {
  response.writeHead(302, { location: location.toString() });
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  return JSON.parse(await readBody(request)) as T;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request));
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
