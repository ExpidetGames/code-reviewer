// A fake of the GitHub REST API as a GitHub App uses it: installations, installation repositories,
// installation access tokens, pull requests and collaborator permissions. A real HTTP server that
// speaks GitHub's protocol, so the production client runs unchanged against it; only the base URL
// differs (`GITHUB_API_BASE_URL`). State is in memory. Dummy values only: the tokens it issues are
// random strings without meaning outside this process.
//
// It checks what GitHub checks: the App JWT must be signed with the app's key (RS256), name the app
// as issuer and not be expired; an installation token must have been issued here, not expired, and
// only reaches the repositories of its installation (narrowed by the `repositories` or
// `repository_ids` of the request) and only does what the permissions of the request allow. A token
// request may not ask for more than the app itself is granted (`setAppPermissions`).
//
// The OAuth part (login) is a separate fake in the same folder.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type FakeInstallation = {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
  suspended?: boolean;
};

export type FakeRepository = {
  id: number;
  /** "owner/name". */
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
};

export type FakePullRequest = {
  number: number;
  title: string;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: { login: string; id: number };
};

/** GitHub's permission names mapped to the level the app (or a token) holds. */
export type FakePermissions = Record<string, "read" | "write" | "admin">;

/** What an app registered like ours is granted unless a test narrows it. */
export const DEFAULT_FAKE_APP_PERMISSIONS: FakePermissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "write",
};

export type FakeCollaboratorPermission = "admin" | "write" | "read" | "none";

/** Makes matching requests fail before they are looked at. */
export type FakeFailure = {
  /** Applies to requests whose path (without query) contains this text; every request when omitted. */
  pathIncludes?: string;
  /** Applies to requests whose query string contains this text, for example "page=2". */
  queryIncludes?: string;
  /** Answers with this status and an empty JSON error body. */
  status?: number;
  headers?: Record<string, string>;
  /** Waits this long before looking at the request (and before the status, if both are given). */
  delayMs?: number;
  /**
   * Looks at the request at once but sends the answer only after this long: the answer reflects the
   * state of GitHub when the request arrived, and reaches the client later, like a slow response.
   */
  responseDelayMs?: number;
  /** How many requests it applies to; forever when omitted. */
  times?: number;
};

export type FakeGithubAppOptions = {
  appId: string;
  /** SPKI PEM of the app's key pair; JWTs are checked against it. */
  publicKeyPem: string;
  host?: string;
  /** Default 0: a free port. */
  port?: number;
  /** The fake's clock in milliseconds since the epoch. Default Date.now. */
  now?: () => number;
};

export type FakeGithubAppRequest = { method: string; path: string };

export type FakeTokenRequest = {
  installationId: number;
  repositories: string[] | null;
  repositoryIds: number[] | null;
  permissions: Record<string, string> | null;
};

export type FakeGithubApp = {
  /** For example http://127.0.0.1:41234 */
  baseUrl: string;
  addInstallation(installation: FakeInstallation): void;
  /** What uninstalling the app does: the installation and everything behind it disappears. */
  removeInstallation(id: number): void;
  suspendInstallation(id: number, suspended: boolean): void;
  setRepositories(installationId: number, repositories: FakeRepository[]): void;
  /**
   * Leaves these repositories out of the pages of `/installation/repositories` while `total_count`
   * still counts them, like a page boundary that skipped one while the list changed.
   */
  omitFromListings(installationId: number, repositoryIds: number[]): void;
  /** Adds a raw record to `/app/installations`, for example one whose account has no login. */
  addRawInstallationRecord(record: Record<string, unknown>): void;
  addRepository(installationId: number, repository: FakeRepository): void;
  removeRepository(installationId: number, repositoryId: number): void;
  addPullRequest(repoFullName: string, pullRequest: FakePullRequest): void;
  setCollaboratorPermission(
    repoFullName: string,
    login: string,
    permission: FakeCollaboratorPermission,
  ): void;
  /** The permissions the app itself is granted; token requests may not exceed them (422). */
  setAppPermissions(permissions: FakePermissions): void;
  /**
   * Merges these fields into every access token answer from now on (null stops it): a misbehaving
   * GitHub that reports a token as broader than it was asked for, for example
   * `{ repository_selection: "all" }`. The token itself is still limited as requested.
   */
  answerTokensWith(patch: Record<string, unknown> | null): void;
  /** Answers 401 to every App JWT, as when the key or app id of the app is wrong. */
  rejectAppJwts(reject: boolean): void;
  fail(failure: FakeFailure): void;
  clearFailures(): void;
  /** Removes all state, recorded requests and failures. */
  reset(): void;
  /** Every request received, in order (method and path only: no headers, no bodies). */
  requests(): FakeGithubAppRequest[];
  /**
   * The body of every access token request that was accepted for a look, in order: `repositories`
   * (names), `repository_ids` and `permissions`, each null when the request did not send it.
   */
  tokenRequests(): FakeTokenRequest[];
  /** Every credential (JWT or token) any request carried; lets a test search outputs for them. */
  seenCredentials(): string[];
  /** Every installation token issued so far. */
  issuedInstallationTokens(): string[];
  close(): Promise<void>;
};

type IssuedToken = {
  installationId: number;
  /** The repositories the token reaches; null means every repository of the installation. */
  repositoryIds: number[] | null;
  permissions: FakePermissions;
  expiresAtMs: number;
};

const LEVELS = ["read", "write", "admin"] as const;
const levelOf = (level: unknown): number =>
  LEVELS.findIndex((candidate) => candidate === level);

const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const MAX_PER_PAGE = 100;

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function pageOf<T>(items: T[], query: URLSearchParams): T[] {
  const perPage = Math.min(
    Math.max(Number(query.get("per_page")) || 30, 1),
    MAX_PER_PAGE,
  );
  const page = Math.max(Number(query.get("page")) || 1, 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

function accountJson(account: FakeInstallation["account"]) {
  return {
    login: account.login,
    id: account.id,
    type: account.type,
    html_url: `https://github.test/${account.login}`,
  };
}

function repositoryJson(repository: FakeRepository) {
  const [owner = ""] = repository.fullName.split("/");
  const ownerId = 9000 + owner.length;
  return {
    id: repository.id,
    name: repository.fullName.split("/")[1],
    full_name: repository.fullName,
    private: repository.private ?? false,
    html_url: `https://github.test/${repository.fullName}`,
    default_branch: repository.defaultBranch ?? "main",
    owner: { login: owner, id: ownerId },
  };
}

function pullRequestJson(repository: FakeRepository, pr: FakePullRequest) {
  return {
    number: pr.number,
    title: pr.title,
    html_url: `https://github.test/${repository.fullName}/pull/${pr.number}`,
    state: pr.state,
    merged: pr.merged ?? false,
    merged_at: pr.merged ? "2026-10-09T10:00:00Z" : null,
    draft: pr.draft ?? false,
    user: { login: pr.author.login, id: pr.author.id },
    head: { sha: pr.headSha, ref: pr.headRef },
    base: { ref: pr.baseRef },
  };
}

function base64urlDecode(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

export async function startGithubAppFake(
  options: FakeGithubAppOptions,
): Promise<FakeGithubApp> {
  const now = options.now ?? Date.now;
  const publicKey = createPublicKey(options.publicKeyPem);

  const installations = new Map<number, FakeInstallation>();
  const repositories = new Map<number, FakeRepository[]>();
  const pullRequests = new Map<string, FakePullRequest[]>();
  const permissions = new Map<string, FakeCollaboratorPermission>();
  const tokens = new Map<string, IssuedToken>();
  const issuedTokens: string[] = [];
  const tokenRequests: FakeTokenRequest[] = [];
  let appPermissions: FakePermissions = { ...DEFAULT_FAKE_APP_PERMISSIONS };
  const omitted = new Map<number, number[]>();
  const rawInstallationRecords: Record<string, unknown>[] = [];
  const log: FakeGithubAppRequest[] = [];
  const credentials: string[] = [];
  let failures: Array<FakeFailure & { remaining: number }> = [];
  let jwtsRejected = false;
  let tokenAnswerPatch: Record<string, unknown> | null = null;

  function jwtIsValid(token: string): boolean {
    if (jwtsRejected) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [header, payload, signature] = parts as [string, string, string];
    try {
      const signed = verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        base64urlDecode(signature),
      );
      if (!signed) return false;
      const claims = JSON.parse(base64urlDecode(payload).toString("utf8")) as {
        iss?: unknown;
        iat?: unknown;
        exp?: unknown;
      };
      const seconds = now() / 1000;
      return (
        claims.iss === options.appId &&
        typeof claims.exp === "number" &&
        typeof claims.iat === "number" &&
        claims.exp > seconds &&
        claims.iat <= seconds &&
        claims.exp - claims.iat <= 600
      );
    } catch {
      return false;
    }
  }

  function installationToken(token: string): IssuedToken | undefined {
    const issued = tokens.get(token);
    if (issued === undefined || issued.expiresAtMs <= now()) return undefined;
    return installations.has(issued.installationId) ? issued : undefined;
  }

  function reposVisibleTo(token: IssuedToken): FakeRepository[] {
    const all = repositories.get(token.installationId) ?? [];
    if (token.repositoryIds === null) return all;
    const allowed = token.repositoryIds;
    return all.filter((repo) => allowed.includes(repo.id));
  }

  /** Does the token hold at least this level of the permission? */
  function mayDo(
    token: IssuedToken,
    permission: string,
    level: "read" | "write",
  ): boolean {
    return levelOf(token.permissions[permission]) >= levelOf(level);
  }

  function takeFailure(path: string, query: string): FakeFailure | undefined {
    const failure = failures.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (candidate.pathIncludes === undefined ||
          path.includes(candidate.pathIncludes)) &&
        (candidate.queryIncludes === undefined ||
          query.includes(candidate.queryIncludes)),
    );
    if (failure === undefined) return undefined;
    failure.remaining -= 1;
    return failure;
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake.test");
    const path = url.pathname;
    const method = request.method ?? "GET";
    log.push({ method, path });

    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (bearer !== undefined) credentials.push(bearer);

    const failure = takeFailure(path, url.search);
    const responseDelayMs = failure?.responseDelayMs;
    // The answer is worked out now (when the request arrived) and sent later.
    const send = async (status: number, body: unknown): Promise<void> => {
      if (responseDelayMs !== undefined)
        await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      json(response, status, body);
    };
    if (failure?.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
    if (failure?.status !== undefined) {
      response.writeHead(failure.status, {
        "content-type": "application/json",
        ...failure.headers,
      });
      response.end(JSON.stringify({ message: "Injected failure" }));
      return;
    }

    const unauthorized = () => send(401, { message: "Bad credentials" });
    const notFound = () => send(404, { message: "Not Found" });

    // App JWT endpoints
    if (path === "/app/installations" && method === "GET") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const list: unknown[] = [...installations.values()].map(
        (installation) => ({
          id: installation.id,
          account: accountJson(installation.account),
          suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
          app_id: Number(options.appId),
        }),
      );
      list.push(...rawInstallationRecords);
      return send(200, pageOf(list, url.searchParams));
    }

    const installationMatch = /^\/app\/installations\/(\d+)$/.exec(path);
    if (installationMatch && method === "GET") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const installation = installations.get(Number(installationMatch[1]));
      if (installation === undefined) return notFound();
      return send(200, {
        id: installation.id,
        account: accountJson(installation.account),
        suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
        app_id: Number(options.appId),
      });
    }

    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(
      path,
    );
    if (tokenMatch && method === "POST") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const installationId = Number(tokenMatch[1]);
      const installation = installations.get(installationId);
      if (installation === undefined) return notFound();
      if (installation.suspended)
        return send(403, { message: "This installation is suspended" });

      const body = await readBody(request);
      let names: string[] | null = null;
      let ids: number[] | null = null;
      let requested: Record<string, string> | null = null;
      if (body !== "") {
        const parsed = JSON.parse(body) as {
          repositories?: unknown;
          repository_ids?: unknown;
          permissions?: unknown;
        };
        if (Array.isArray(parsed.repositories))
          names = parsed.repositories.map(String);
        if (Array.isArray(parsed.repository_ids))
          ids = parsed.repository_ids.map(Number);
        if (
          typeof parsed.permissions === "object" &&
          parsed.permissions !== null
        )
          requested = Object.fromEntries(
            Object.entries(parsed.permissions).map(([key, level]) => [
              key,
              String(level),
            ]),
          );
      }
      tokenRequests.push({
        installationId,
        repositories: names,
        repositoryIds: ids,
        permissions: requested,
      });

      // Like GitHub: a repository the installation does not have is refused as a whole (422), and
      // so is a permission the app does not hold at that level. Nothing broader is issued instead.
      const known = repositories.get(installationId) ?? [];
      const unknownName =
        names !== null &&
        names.some(
          (name) => !known.some((repo) => repo.fullName.split("/")[1] === name),
        );
      const unknownId =
        ids !== null &&
        ids.some(
          (id) =>
            !Number.isInteger(id) || !known.some((repo) => repo.id === id),
        );
      if (unknownName || unknownId)
        return send(422, {
          message:
            "There is at least one repository that does not exist or is not accessible",
        });
      if (
        requested !== null &&
        Object.entries(requested).some(
          ([key, level]) =>
            levelOf(level) < 0 || levelOf(level) > levelOf(appPermissions[key]),
        )
      )
        return send(422, {
          message:
            "The permissions requested are not granted to this installation",
        });

      let reach: number[] | null = null;
      if (names !== null || ids !== null)
        reach = known
          .filter(
            (repo) =>
              (names?.includes(repo.fullName.split("/")[1] ?? "") ?? false) ||
              (ids?.includes(repo.id) ?? false),
          )
          .map((repo) => repo.id);
      const granted: FakePermissions =
        requested === null
          ? { ...appPermissions }
          : (requested as FakePermissions);

      const token = `ghs_fake${randomBytes(16).toString("hex")}`;
      const expiresAtMs = now() + TOKEN_LIFETIME_MS;
      tokens.set(token, {
        installationId,
        repositoryIds: reach,
        permissions: granted,
        expiresAtMs,
      });
      issuedTokens.push(token);
      return send(201, {
        token,
        expires_at: new Date(expiresAtMs).toISOString(),
        permissions: granted,
        repository_selection: reach === null ? "all" : "selected",
        ...tokenAnswerPatch,
      });
    }

    // Installation token endpoints
    const issued = bearer === undefined ? undefined : installationToken(bearer);

    if (path === "/installation/repositories" && method === "GET") {
      if (issued === undefined) return unauthorized();
      const all = reposVisibleTo(issued);
      const hidden = omitted.get(issued.installationId) ?? [];
      const listed = all.filter((repo) => !hidden.includes(repo.id));
      return send(200, {
        total_count: all.length,
        repositories: pageOf(listed, url.searchParams).map(repositoryJson),
      });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch) {
      if (issued === undefined) return unauthorized();
      const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
      const repository = reposVisibleTo(issued).find(
        (repo) => repo.fullName === fullName,
      );
      if (repository === undefined) return notFound();
      const rest = repoMatch[3] ?? "";
      const prs = pullRequests.get(fullName) ?? [];

      const forbidden = () =>
        send(403, { message: "Resource not accessible by integration" });

      if (rest === "/pulls" && method === "GET") {
        if (!mayDo(issued, "pull_requests", "read")) return forbidden();
        const state = url.searchParams.get("state") ?? "open";
        const matching = prs.filter(
          (pr) => state === "all" || pr.state === state,
        );
        return send(
          200,
          pageOf(matching, url.searchParams).map((pr) =>
            pullRequestJson(repository, pr),
          ),
        );
      }
      const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
      if (pullMatch && method === "GET") {
        if (!mayDo(issued, "pull_requests", "read")) return forbidden();
        const pr = prs.find((item) => item.number === Number(pullMatch[1]));
        if (pr === undefined) return notFound();
        return send(200, pullRequestJson(repository, pr));
      }
      const permissionMatch = /^\/collaborators\/([^/]+)\/permission$/.exec(
        rest,
      );
      if (permissionMatch && method === "GET") {
        if (!mayDo(issued, "metadata", "read")) return forbidden();
        const login = decodeURIComponent(permissionMatch[1] ?? "");
        const permission =
          permissions.get(`${fullName}#${login.toLowerCase()}`) ?? "none";
        return send(200, {
          permission,
          user: { login },
        });
      }
    }

    return notFound();
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent)
        json(response, 500, { message: "Fake failed" });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const host = options.host ?? "127.0.0.1";

  return {
    baseUrl: `http://${host}:${address.port}`,
    addInstallation(installation) {
      installations.set(installation.id, installation);
      if (!repositories.has(installation.id))
        repositories.set(installation.id, []);
    },
    removeInstallation(id) {
      installations.delete(id);
      repositories.delete(id);
    },
    suspendInstallation(id, suspended) {
      const installation = installations.get(id);
      if (installation) installation.suspended = suspended;
    },
    setRepositories(installationId, list) {
      repositories.set(installationId, [...list]);
    },
    omitFromListings(installationId, repositoryIds) {
      omitted.set(installationId, [...repositoryIds]);
    },
    addRawInstallationRecord(record) {
      rawInstallationRecords.push(record);
    },
    addRepository(installationId, repository) {
      const list = repositories.get(installationId) ?? [];
      repositories.set(installationId, [
        ...list.filter((item) => item.id !== repository.id),
        repository,
      ]);
    },
    removeRepository(installationId, repositoryId) {
      repositories.set(
        installationId,
        (repositories.get(installationId) ?? []).filter(
          (item) => item.id !== repositoryId,
        ),
      );
    },
    addPullRequest(repoFullName, pullRequest) {
      pullRequests.set(repoFullName, [
        ...(pullRequests.get(repoFullName) ?? []),
        pullRequest,
      ]);
    },
    setCollaboratorPermission(repoFullName, login, permission) {
      permissions.set(`${repoFullName}#${login.toLowerCase()}`, permission);
    },
    setAppPermissions(permissions) {
      appPermissions = { ...permissions };
    },
    answerTokensWith(patch) {
      tokenAnswerPatch = patch;
    },
    rejectAppJwts(reject) {
      jwtsRejected = reject;
    },
    fail(failure) {
      failures.push({ ...failure, remaining: failure.times ?? Infinity });
    },
    clearFailures() {
      failures = [];
    },
    reset() {
      installations.clear();
      repositories.clear();
      pullRequests.clear();
      permissions.clear();
      omitted.clear();
      rawInstallationRecords.length = 0;
      tokens.clear();
      issuedTokens.length = 0;
      tokenRequests.length = 0;
      log.length = 0;
      credentials.length = 0;
      failures = [];
      jwtsRejected = false;
      tokenAnswerPatch = null;
      appPermissions = { ...DEFAULT_FAKE_APP_PERMISSIONS };
    },
    requests: () => [...log],
    tokenRequests: () => [...tokenRequests],
    seenCredentials: () => [...credentials],
    issuedInstallationTokens: () => [...issuedTokens],
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
