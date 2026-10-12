// SPDX-License-Identifier: Apache-2.0

// A small GitHub client for the app: authenticates as the app (JWT) and as an installation (token),
// lists installations and their repositories, reads pull requests and permissions. Everything it
// returns is already in the shapes the provider needs; nothing outside this folder sees GitHub JSON.
//
// Errors are `GithubAppError`s with a stable code (see errors.ts). A message names the call and the
// status only: never the JWT, a token, a key or a response body.
import type { GithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { createAppJwt } from "./jwt.ts";
import { toPullRequestRef } from "./mappers.ts";
import type { PullRequestRef } from "../../types.ts";

export type RemoteInstallation = {
  /** The installation id as text. */
  id: string;
  accountLogin: string;
  accountId: number;
  accountType: string;
  suspended: boolean;
};

export type RemoteRepository = {
  externalId: string;
  /** "owner/name". */
  fullName: string;
  url: string;
};

/** The app as `GET /app` describes it to its own JWT. */
export type RemoteApp = {
  /** The app id as text. */
  id: string;
  slug: string;
  /** The account the App belongs to (`owner` of `GET /app`), or null when GitHub does not say. */
  owner: { id: number; login: string } | null;
  /** The permissions the App holds, by API name (`pull_requests`, `emails`, `members`, ...). */
  permissions: Record<string, string>;
};

export type CollaboratorPermission = "admin" | "write" | "read" | "none";

export type InstallationToken = {
  token: string;
  /** ISO 8601 text in UTC. */
  expiresAt: string;
};

/** GitHub's permission names mapped to a level; what a token request asks for and a token holds. */
export type InstallationPermissions = Readonly<
  Record<string, "read" | "write">
>;

/** What a job token is limited to. Both parts are required: a job token is never broader. */
export type JobTokenScope = {
  /** The numeric ids of the repositories (at least one) the token may reach. */
  repositoryIds: readonly number[];
  permissions: InstallationPermissions;
};

export type GithubAppClient = {
  /**
   * The app itself (`GET /app`, App JWT): proves that the key belongs to the app id, and says what the
   * App is granted. Rejects with GITHUB_APP_AUTH_FAILED when GitHub refuses the JWT.
   */
  getApp(): Promise<RemoteApp>;
  /** Every installation of the app (needs the App JWT). */
  listInstallations(): Promise<RemoteInstallation[]>;
  /** One installation, or null when GitHub does not know it (it was removed, or is not ours). */
  getInstallation(installationId: string): Promise<RemoteInstallation | null>;
  /** Every repository the installation may see, all pages. Rejects when a page cannot be read. */
  listInstallationRepositories(
    installationId: string,
  ): Promise<RemoteRepository[]>;
  /**
   * Rejects with GITHUB_APP_NOT_FOUND for an unknown pull request. When `signal` fires, the HTTP
   * request in flight is aborted (the connection is closed) and the call rejects with
   * GITHUB_APP_UNAVAILABLE.
   */
  getPullRequest(
    installationId: string,
    repoFullName: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<PullRequestRef>;
  /** Aborts like `getPullRequest` when `signal` fires, also between two pages. */
  listOpenPullRequests(
    installationId: string,
    repoFullName: string,
    signal?: AbortSignal,
  ): Promise<PullRequestRef[]>;
  /** The repository permission of a user; "none" for a user GitHub does not know. */
  getCollaboratorPermission(
    installationId: string,
    repoFullName: string,
    login: string,
  ): Promise<CollaboratorPermission>;
  /**
   * Mints a fresh installation access token, never from the cache, limited to the given repositories
   * and permissions. The one place a token for a job is created. Refuses (without a request) a scope
   * with no repository or no permission, and a token GitHub reports as broader than asked for.
   */
  mintInstallationToken(
    installationId: string,
    scope: JobTokenScope,
  ): Promise<InstallationToken>;
};

export type GithubAppClientOptions = {
  config: GithubAppConfig;
  /** Default: the global fetch at call time. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** How long one request may take before it counts as unavailable. Default 15 seconds. */
  requestTimeoutMs?: number;
  /** Receives a warning about a record that is skipped. Default: console.warn. */
  warn?: (line: string) => void;
};

const PAGE_SIZE = 100;
/** A hard stop so a misbehaving server cannot loop us forever; reaching it is an error, not a cut. */
const MAX_PAGES = 100;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
/** A JWT lives about 9 minutes (see jwt.ts); reuse it for 5 so it never expires mid-call. */
const JWT_REUSE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = "2022-11-28";

function shapeError(call: string): GithubAppError {
  return new GithubAppError(
    "GITHUB_APP_REQUEST_FAILED",
    `GitHub answered ${call} in an unexpected format.`,
  );
}

/**
 * One installation record. Returns `skip` for a record whose account has no login or type (for
 * example some enterprise accounts), so one odd record cannot block the whole listing; throws for a
 * record that is not even an installation.
 */
function toInstallation(
  value: unknown,
  call: string,
): RemoteInstallation | { skip: string } {
  if (!isRecord(value) || typeof value.id !== "number") throw shapeError(call);
  const { id, account } = value;
  if (
    !isRecord(account) ||
    typeof account.login !== "string" ||
    typeof account.id !== "number" ||
    typeof account.type !== "string"
  )
    return { skip: `installation ${id}: its account has no login, id or type` };
  return {
    id: String(id),
    accountLogin: account.login,
    accountId: account.id,
    accountType: account.type,
    suspended: typeof value.suspended_at === "string",
  };
}

function toRepository(value: unknown, call: string): RemoteRepository {
  if (!isRecord(value)) throw shapeError(call);
  if (
    typeof value.id !== "number" ||
    typeof value.full_name !== "string" ||
    typeof value.html_url !== "string"
  )
    throw shapeError(call);
  return {
    externalId: String(value.id),
    fullName: value.full_name,
    url: value.html_url,
  };
}

function checkInstallationId(installationId: string): void {
  if (!/^\d+$/.test(installationId))
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The installation id is not a number.",
    );
}

/** A path segment must be a real name: `.` and `..` would make the URL point somewhere else. */
function isPlainSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== "..";
}

function repoPath(repoFullName: string): string {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repoFullName);
  const owner = match?.[1];
  const name = match?.[2];
  if (
    owner === undefined ||
    name === undefined ||
    !isPlainSegment(owner) ||
    !isPlainSegment(name)
  )
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The repository name is not in the form owner/name.",
    );
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function checkPullRequestNumber(prNumber: number): void {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1)
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The pull request number is not a positive whole number.",
    );
}

const PERMISSION_LEVELS = ["read", "write", "admin"];

/**
 * GitHub echoes what a token really holds, and this check is the last defence behind "never
 * broader": it fails closed. The answer must say the token is limited to selected repositories, list
 * only repositories that were asked for, and list permissions with known levels that are none of
 * them above what was asked for. A missing field, an unknown permission or an unknown level fails.
 */
function isNoBroaderThan(
  json: Record<string, unknown>,
  scope: JobTokenScope,
): boolean {
  if (json.repository_selection !== "selected") return false;
  if (!Array.isArray(json.repositories)) return false;
  for (const repo of json.repositories)
    if (
      !isRecord(repo) ||
      !scope.repositoryIds.some((wanted) => wanted === repo.id)
    )
      return false;
  if (!isRecord(json.permissions)) return false;
  for (const [name, level] of Object.entries(json.permissions)) {
    const asked = scope.permissions[name];
    const held = PERMISSION_LEVELS.indexOf(String(level));
    if (asked === undefined || held === -1) return false;
    if (held > PERMISSION_LEVELS.indexOf(asked)) return false;
  }
  return true;
}

export function createGithubAppClient(
  options: GithubAppClientOptions,
): GithubAppClient {
  const { config } = options;
  const now = options.now ?? Date.now;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const doFetch: typeof fetch = (input, init) =>
    (options.fetch ?? globalThis.fetch)(input, init);
  const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

  // One JWT serves many calls (a listing needs one per page): keep it until shortly before it ends.
  let cachedJwt: { jwt: string; reuseUntilMs: number } | undefined;
  function appJwt(): string {
    const nowMs = now();
    if (cachedJwt && nowMs < cachedJwt.reuseUntilMs) return cachedJwt.jwt;
    const jwt = createAppJwt({
      appId: config.appId,
      privateKey: config.privateKey,
      nowMs,
    });
    cachedJwt = { jwt, reuseUntilMs: nowMs + JWT_REUSE_MS };
    return jwt;
  }

  /** Seconds to wait as the platform said (never negative), or null when it did not say. */
  function retryAfter(headers: Headers): number | null {
    const direct = headers.get("retry-after")?.trim();
    if (
      direct !== undefined &&
      direct !== "" &&
      Number.isFinite(Number(direct))
    )
      return Math.max(0, Number(direct));
    const reset = headers.get("x-ratelimit-reset")?.trim();
    if (reset !== undefined && reset !== "" && Number.isFinite(Number(reset)))
      return Math.max(0, Math.ceil(Number(reset) - now() / 1000));
    return null;
  }

  function errorForStatus(
    method: string,
    path: string,
    response: Response,
  ): GithubAppError {
    const status = response.status;
    const call = `${method} ${path}`;
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (response.headers.get("retry-after") !== null ||
          response.headers.get("x-ratelimit-remaining") === "0"));
    if (rateLimited)
      return new GithubAppError(
        "GITHUB_APP_RATE_LIMITED",
        `GitHub rate limit reached for ${call}.`,
        { status, retryAfterSeconds: retryAfter(response.headers) },
      );
    const code =
      status === 401
        ? "GITHUB_APP_AUTH_FAILED"
        : status === 403
          ? "GITHUB_APP_FORBIDDEN"
          : status === 404
            ? "GITHUB_APP_NOT_FOUND"
            : status >= 500
              ? "GITHUB_APP_UNAVAILABLE"
              : "GITHUB_APP_REQUEST_FAILED";
    return new GithubAppError(code, `GitHub answered ${status} for ${call}.`, {
      status,
      // A 5xx may say when to come back (Retry-After); everything else has nothing to wait for.
      retryAfterSeconds: status >= 500 ? retryAfter(response.headers) : null,
    });
  }

  async function request(
    credential: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    // The client's own timeout always applies; the caller's signal can only end the request sooner.
    const requestSignal =
      signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      response = await doFetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          "user-agent": `code-reviewer-${config.slug}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
    } catch {
      // The cause is dropped on purpose: it can quote the request.
      throw new GithubAppError(
        "GITHUB_APP_UNAVAILABLE",
        `GitHub could not be reached for ${method} ${path.split("?")[0]}.`,
      );
    }
    if (!response.ok) {
      // The body is not read (it is never needed and must not end up in a message); free the socket.
      await response.body?.cancel().catch(() => undefined);
      throw errorForStatus(method, path.split("?")[0] as string, response);
    }
    try {
      return await response.json();
    } catch {
      // Cut off while the body was read (the caller's signal or the timeout): the answer is missing,
      // not malformed.
      if (requestSignal.aborted)
        throw new GithubAppError(
          "GITHUB_APP_UNAVAILABLE",
          `GitHub could not be reached for ${method} ${path.split("?")[0]}.`,
        );
      throw shapeError(`${method} ${path.split("?")[0]}`);
    }
  }

  async function allPages<T>(
    credential: () => Promise<string>,
    path: string,
    pick: (json: unknown) => unknown[],
    map: (item: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const json = await request(
        await credential(),
        "GET",
        `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
        undefined,
        signal,
      );
      const batch = pick(json);
      items.push(...batch.map(map));
      if (batch.length < PAGE_SIZE) return items;
    }
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      `GitHub listed more than ${MAX_PAGES * PAGE_SIZE} items for ${path.split("?")[0]}.`,
    );
  }

  /**
   * Best effort `DELETE /installation/token` for a token that must not be used. Its failure is
   * ignored (the original failure is what the caller needs to hear about) and the answer is never
   * read, so nothing of it can reach a message.
   */
  async function revokeInstallationToken(token: string): Promise<void> {
    try {
      const response = await doFetch(
        `${config.apiBaseUrl}/installation/token`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": `code-reviewer-${config.slug}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Ignored on purpose, see above.
    }
  }

  /** Read calls: a token with everything the app is granted on the whole installation. */
  async function mint(
    installationId: string,
    scope?: JobTokenScope,
    signal?: AbortSignal,
  ): Promise<InstallationToken> {
    checkInstallationId(installationId);
    let json: unknown;
    try {
      json = await request(
        appJwt(),
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        scope === undefined
          ? undefined
          : {
              repository_ids: [...scope.repositoryIds],
              permissions: { ...scope.permissions },
            },
        signal,
      );
    } catch (error) {
      // Same code and message; only marked as the answer to the token request.
      if (error instanceof GithubAppError)
        throw new GithubAppError(error.code, error.message, {
          status: error.status,
          retryAfterSeconds: error.retryAfterSeconds,
          duringTokenRequest: true,
        });
      throw error;
    }
    if (
      !isRecord(json) ||
      typeof json.token !== "string" ||
      json.token === "" ||
      typeof json.expires_at !== "string" ||
      Number.isNaN(Date.parse(json.expires_at))
    )
      throw shapeError("POST /app/installations/{id}/access_tokens");
    if (scope !== undefined && !isNoBroaderThan(json, scope)) {
      // The token exists and works for up to an hour: switch it off before reporting the failure.
      await revokeInstallationToken(json.token);
      throw new GithubAppError(
        "GITHUB_APP_REQUEST_FAILED",
        "GitHub issued a token broader than the one asked for; it was discarded.",
      );
    }
    return {
      token: json.token,
      expiresAt: new Date(Date.parse(json.expires_at)).toISOString(),
    };
  }

  async function cachedToken(
    installationId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - now() > TOKEN_EXPIRY_BUFFER_MS)
      return cached.token;
    const minted = await mint(installationId, undefined, signal);
    tokenCache.set(installationId, {
      token: minted.token,
      expiresAtMs: Date.parse(minted.expiresAt),
    });
    return minted.token;
  }

  /** Runs a read with the installation's cached token; one retry with a fresh one if GitHub refuses it. */
  async function withInstallationToken<T>(
    installationId: string,
    run: (token: () => Promise<string>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await run(() => cachedToken(installationId, signal));
    } catch (error) {
      if (
        !(error instanceof GithubAppError) ||
        error.code !== "GITHUB_APP_AUTH_FAILED" ||
        !tokenCache.has(installationId)
      )
        throw error;
      tokenCache.delete(installationId);
      return run(() => cachedToken(installationId, signal));
    }
  }

  return {
    async getApp() {
      const json = await request(appJwt(), "GET", "/app");
      if (
        !isRecord(json) ||
        typeof json.id !== "number" ||
        typeof json.slug !== "string"
      )
        throw shapeError("GET /app");
      const permissions: Record<string, string> = {};
      if (isRecord(json.permissions))
        for (const [name, level] of Object.entries(json.permissions))
          if (typeof level === "string") permissions[name] = level;
      const owner = json.owner;
      return {
        id: String(json.id),
        slug: json.slug,
        owner:
          isRecord(owner) &&
          typeof owner.id === "number" &&
          typeof owner.login === "string"
            ? { id: owner.id, login: owner.login }
            : null,
        permissions,
      };
    },

    listInstallations() {
      return allPages(
        async () => appJwt(),
        "/app/installations",
        (json) => {
          if (!Array.isArray(json)) throw shapeError("GET /app/installations");
          return json;
        },
        (item) => toInstallation(item, "GET /app/installations"),
      ).then((items) =>
        items.flatMap((item) => {
          if (!("skip" in item)) return [item];
          warn(`[github-app] skipped ${item.skip}.`);
          return [];
        }),
      );
    },

    async getInstallation(installationId) {
      checkInstallationId(installationId);
      try {
        const json = await request(
          appJwt(),
          "GET",
          `/app/installations/${installationId}`,
        );
        const installation = toInstallation(
          json,
          "GET /app/installations/{id}",
        );
        // Unlike a listing, a single lookup cannot skip: the caller asked for exactly this one.
        if ("skip" in installation)
          throw shapeError("GET /app/installations/{id}");
        return installation;
      } catch (error) {
        if (
          error instanceof GithubAppError &&
          error.code === "GITHUB_APP_NOT_FOUND"
        )
          return null;
        throw error;
      }
    },

    async listInstallationRepositories(installationId) {
      checkInstallationId(installationId);
      return withInstallationToken(installationId, async (token) => {
        let total: number | undefined;
        const repositories = await allPages(
          token,
          "/installation/repositories",
          (json) => {
            if (!isRecord(json) || !Array.isArray(json.repositories))
              throw shapeError("GET /installation/repositories");
            total =
              typeof json.total_count === "number" ? json.total_count : total;
            return json.repositories;
          },
          (item) => toRepository(item, "GET /installation/repositories"),
        );
        // Pages are read one after the other while repositories may be added or removed, which can
        // make a page boundary skip one. A list shorter than GitHub's own count is incomplete, and
        // an incomplete list must never be taken for "the others are gone".
        const distinct = new Set(repositories.map((repo) => repo.externalId));
        if (total !== undefined && distinct.size < total)
          throw new GithubAppError(
            "GITHUB_APP_UNAVAILABLE",
            `GitHub listed ${distinct.size} of ${total} repositories; try again.`,
          );
        return repositories;
      });
    },

    async getPullRequest(installationId, repoFullName, prNumber, signal) {
      checkInstallationId(installationId);
      checkPullRequestNumber(prNumber);
      const path = `${repoPath(repoFullName)}/pulls/${prNumber}`;
      return withInstallationToken(
        installationId,
        async (token) => {
          const json = await request(
            await token(),
            "GET",
            path,
            undefined,
            signal,
          );
          const pr = toPullRequestRef(json);
          if (pr === null)
            throw shapeError("GET /repos/{owner}/{repo}/pulls/{n}");
          return pr;
        },
        signal,
      );
    },

    async listOpenPullRequests(installationId, repoFullName, signal) {
      checkInstallationId(installationId);
      return withInstallationToken(
        installationId,
        (token) =>
          allPages(
            token,
            `${repoPath(repoFullName)}/pulls?state=open`,
            (json) => {
              if (!Array.isArray(json))
                throw shapeError("GET /repos/{owner}/{repo}/pulls");
              return json;
            },
            (item) => {
              const pr = toPullRequestRef(item);
              if (pr === null)
                throw shapeError("GET /repos/{owner}/{repo}/pulls");
              return pr;
            },
            signal,
          ),
        signal,
      );
    },

    async getCollaboratorPermission(installationId, repoFullName, login) {
      checkInstallationId(installationId);
      if (!isPlainSegment(login))
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "The login is not a usable user name.",
        );
      const path = `${repoPath(repoFullName)}/collaborators/${encodeURIComponent(login)}/permission`;
      return withInstallationToken(installationId, async (token) => {
        try {
          const json = await request(await token(), "GET", path);
          const permission = isRecord(json) ? json.permission : undefined;
          if (
            permission === "admin" ||
            permission === "write" ||
            permission === "read" ||
            permission === "none"
          )
            return permission;
          throw shapeError(
            "GET /repos/{owner}/{repo}/collaborators/{user}/permission",
          );
        } catch (error) {
          // GitHub answers 404 for a login it does not know: that user has no access.
          if (
            error instanceof GithubAppError &&
            error.code === "GITHUB_APP_NOT_FOUND"
          )
            return "none" as const;
          throw error;
        }
      });
    },

    async mintInstallationToken(installationId, scope) {
      if (scope.repositoryIds.length === 0)
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "A job token needs at least one repository.",
        );
      if (
        !scope.repositoryIds.every((id) => Number.isSafeInteger(id) && id > 0)
      )
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "A repository id is not a positive whole number.",
        );
      if (Object.keys(scope.permissions).length === 0)
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "A job token needs explicit permissions.",
        );
      return mint(installationId, scope);
    },
  };
}
