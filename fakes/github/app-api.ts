// A fake of the GitHub REST API as a GitHub App uses it: installations, installation repositories,
// installation access tokens, pull requests and collaborator permissions. A real HTTP server that
// speaks GitHub's protocol, so the production client runs unchanged against it; only the base URL
// differs (`GITHUB_API_BASE_URL`). State is in memory. Dummy values only: the tokens it issues are
// random strings without meaning outside this process.
//
// It checks what GitHub checks: the App JWT must be signed with the app's key (RS256), name the app
// as issuer and not be expired; an installation token must have been issued here, not expired, and
// only reaches the repositories of its installation (narrowed by the `repositories` of the request).
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
  /** Waits this long before answering (or before the status, if both are given). */
  delayMs?: number;
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

export type FakeGithubApp = {
  /** For example http://127.0.0.1:41234 */
  baseUrl: string;
  addInstallation(installation: FakeInstallation): void;
  /** What uninstalling the app does: the installation and everything behind it disappears. */
  removeInstallation(id: number): void;
  suspendInstallation(id: number, suspended: boolean): void;
  setRepositories(installationId: number, repositories: FakeRepository[]): void;
  addRepository(installationId: number, repository: FakeRepository): void;
  removeRepository(installationId: number, repositoryId: number): void;
  addPullRequest(repoFullName: string, pullRequest: FakePullRequest): void;
  setCollaboratorPermission(
    repoFullName: string,
    login: string,
    permission: FakeCollaboratorPermission,
  ): void;
  /** Answers 401 to every App JWT, as when the key or app id of the app is wrong. */
  rejectAppJwts(reject: boolean): void;
  fail(failure: FakeFailure): void;
  clearFailures(): void;
  /** Removes all state, recorded requests and failures. */
  reset(): void;
  /** Every request received, in order (method and path only: no headers, no bodies). */
  requests(): FakeGithubAppRequest[];
  /** The `repositories` filters of access token requests, in order (null when none was sent). */
  tokenRequests(): Array<{ installationId: number; repositories: string[] | null }>;
  /** Every credential (JWT or token) any request carried; lets a test search outputs for them. */
  seenCredentials(): string[];
  /** Every installation token issued so far. */
  issuedInstallationTokens(): string[];
  close(): Promise<void>;
};

type IssuedToken = {
  installationId: number;
  repositoryNames: string[] | null;
  expiresAtMs: number;
};

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
  const tokenRequests: Array<{
    installationId: number;
    repositories: string[] | null;
  }> = [];
  const log: FakeGithubAppRequest[] = [];
  const credentials: string[] = [];
  let failures: Array<FakeFailure & { remaining: number }> = [];
  let jwtsRejected = false;

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
    if (token.repositoryNames === null) return all;
    const allowed = token.repositoryNames;
    return all.filter((repo) =>
      allowed.includes(repo.fullName.split("/")[1] ?? ""),
    );
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

    const unauthorized = () => json(response, 401, { message: "Bad credentials" });
    const notFound = () => json(response, 404, { message: "Not Found" });

    // App JWT endpoints
    if (path === "/app/installations" && method === "GET") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const list = [...installations.values()].map((installation) => ({
        id: installation.id,
        account: accountJson(installation.account),
        suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
        app_id: Number(options.appId),
      }));
      return json(response, 200, pageOf(list, url.searchParams));
    }

    const installationMatch = /^\/app\/installations\/(\d+)$/.exec(path);
    if (installationMatch && method === "GET") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const installation = installations.get(Number(installationMatch[1]));
      if (installation === undefined) return notFound();
      return json(response, 200, {
        id: installation.id,
        account: accountJson(installation.account),
        suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
        app_id: Number(options.appId),
      });
    }

    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (tokenMatch && method === "POST") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const installationId = Number(tokenMatch[1]);
      const installation = installations.get(installationId);
      if (installation === undefined) return notFound();
      if (installation.suspended)
        return json(response, 403, { message: "This installation is suspended" });

      const body = await readBody(request);
      let names: string[] | null = null;
      if (body !== "") {
        const parsed = JSON.parse(body) as { repositories?: unknown };
        if (Array.isArray(parsed.repositories))
          names = parsed.repositories.map(String);
      }
      tokenRequests.push({ installationId, repositories: names });
      const known = (repositories.get(installationId) ?? []).map(
        (repo) => repo.fullName.split("/")[1] ?? "",
      );
      if (names !== null && names.some((name) => !known.includes(name)))
        return json(response, 422, {
          message: "There is at least one repository that does not exist or is not accessible",
        });

      const token = `ghs_fake${randomBytes(16).toString("hex")}`;
      const expiresAtMs = now() + TOKEN_LIFETIME_MS;
      tokens.set(token, { installationId, repositoryNames: names, expiresAtMs });
      issuedTokens.push(token);
      return json(response, 201, {
        token,
        expires_at: new Date(expiresAtMs).toISOString(),
        repository_selection: names === null ? "all" : "selected",
      });
    }

    // Installation token endpoints
    const issued = bearer === undefined ? undefined : installationToken(bearer);

    if (path === "/installation/repositories" && method === "GET") {
      if (issued === undefined) return unauthorized();
      const all = reposVisibleTo(issued);
      return json(response, 200, {
        total_count: all.length,
        repositories: pageOf(all, url.searchParams).map(repositoryJson),
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

      if (rest === "/pulls" && method === "GET") {
        const state = url.searchParams.get("state") ?? "open";
        const matching = prs.filter(
          (pr) => state === "all" || pr.state === state,
        );
        return json(
          response,
          200,
          pageOf(matching, url.searchParams).map((pr) =>
            pullRequestJson(repository, pr),
          ),
        );
      }
      const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
      if (pullMatch && method === "GET") {
        const pr = prs.find((item) => item.number === Number(pullMatch[1]));
        if (pr === undefined) return notFound();
        return json(response, 200, pullRequestJson(repository, pr));
      }
      const permissionMatch = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
      if (permissionMatch && method === "GET") {
        const login = decodeURIComponent(permissionMatch[1] ?? "");
        const permission =
          permissions.get(`${fullName}#${login.toLowerCase()}`) ?? "none";
        return json(response, 200, {
          permission,
          user: { login },
        });
      }
    }

    return notFound();
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { message: "Fake failed" });
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
      tokens.clear();
      issuedTokens.length = 0;
      tokenRequests.length = 0;
      log.length = 0;
      credentials.length = 0;
      failures = [];
      jwtsRejected = false;
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
