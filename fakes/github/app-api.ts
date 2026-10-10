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
// It is one part of the single fake GitHub (`server.ts`), which owns the HTTP server, the request
// log, the base URL and the failure injection; the sign in part (`oauth.ts`) sits next to it.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "./http.ts";

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

/** The GitHub App registered at the fake: what the App JWTs of the app under test are checked with. */
export type FakeAppOptions = {
  appId: string;
  /** SPKI PEM of the app's key pair; JWTs are checked against it. */
  publicKeyPem: string;
  /** The fake's clock in milliseconds since the epoch. Default Date.now. */
  now?: () => number;
};

export type FakeTokenRequest = {
  installationId: number;
  repositories: string[] | null;
  repositoryIds: number[] | null;
  permissions: Record<string, string> | null;
};

/** What the GitHub App part of the fake offers a test (see `FakeGithub` in `server.ts` for the whole). */
export type FakeGithubAppControls = {
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
  /** Adds a pull request; one with the same number in the same repository is replaced. */
  addPullRequest(repoFullName: string, pullRequest: FakePullRequest): void;
  /** Changes fields of an added pull request, like a push (`headSha`) or a close (`state`). */
  updatePullRequest(
    repoFullName: string,
    number: number,
    changes: Partial<Omit<FakePullRequest, "number">>,
  ): void;
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
  /**
   * The body of every access token request that was accepted for a look, in order: `repositories`
   * (names), `repository_ids` and `permissions`, each null when the request did not send it.
   */
  tokenRequests(): FakeTokenRequest[];
  /** Every installation token issued so far. */
  issuedInstallationTokens(): string[];
  /** Every installation token switched off with `DELETE /installation/token`, in order. */
  revokedInstallationTokens(): string[];
};

export type AppPart = {
  controls: FakeGithubAppControls;
  /**
   * Answers the request when the path belongs to the GitHub App API; false when it does not.
   * `bearer` is the credential the request carried, `reply` sends an answer (late, if the injected
   * failure asks for that).
   */
  handle(context: {
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    bearer: string | undefined;
    reply: (status: number, body: unknown) => Promise<void>;
  }): Promise<boolean>;
  /** Removes all state of the App API. */
  reset(): void;
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

export function createAppPart(options: FakeAppOptions): AppPart {
  const now = options.now ?? Date.now;
  const publicKey = createPublicKey(options.publicKeyPem);

  const installations = new Map<number, FakeInstallation>();
  const repositories = new Map<number, FakeRepository[]>();
  const pullRequests = new Map<string, FakePullRequest[]>();
  const permissions = new Map<string, FakeCollaboratorPermission>();
  const tokens = new Map<string, IssuedToken>();
  const issuedTokens: string[] = [];
  const revoked: string[] = [];
  const tokenRequests: FakeTokenRequest[] = [];
  let appPermissions: FakePermissions = { ...DEFAULT_FAKE_APP_PERMISSIONS };
  const omitted = new Map<number, number[]>();
  const rawInstallationRecords: Record<string, unknown>[] = [];
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

  async function handle(
    context: Parameters<AppPart["handle"]>[0],
  ): Promise<boolean> {
    let answered = false;
    await route(context, async (status, body) => {
      answered = true;
      await context.reply(status, body);
    });
    return answered || context.response.writableEnded;
  }

  // Answers through `send`; a path that is not part of the GitHub App API is left unanswered.
  async function route(
    { request, url, bearer, response }: Parameters<AppPart["handle"]>[0],
    send: (status: number, body: unknown) => Promise<void>,
  ): Promise<void> {
    const path = url.pathname;
    const method = request.method ?? "GET";

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
        ...(reach === null
          ? {}
          : {
              repositories: known
                .filter((repo) => reach.includes(repo.id))
                .map(repositoryJson),
            }),
        ...tokenAnswerPatch,
      });
    }

    // Installation token endpoints
    const issued = bearer === undefined ? undefined : installationToken(bearer);

    if (path === "/installation/token" && method === "DELETE") {
      if (issued === undefined || bearer === undefined) return unauthorized();
      tokens.delete(bearer);
      revoked.push(bearer);
      response.writeHead(204);
      response.end();
      return;
    }

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
  }

  const controls: FakeGithubAppControls = {
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
        ...(pullRequests.get(repoFullName) ?? []).filter(
          (existing) => existing.number !== pullRequest.number,
        ),
        pullRequest,
      ]);
    },
    updatePullRequest(repoFullName, number, changes) {
      const existing = pullRequests.get(repoFullName) ?? [];
      if (!existing.some((pr) => pr.number === number))
        throw new Error(`no pull request ${number} in ${repoFullName}`);
      pullRequests.set(
        repoFullName,
        existing.map((pr) =>
          pr.number === number ? { ...pr, ...changes } : pr,
        ),
      );
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
    tokenRequests: () => [...tokenRequests],
    issuedInstallationTokens: () => [...issuedTokens],
    revokedInstallationTokens: () => [...revoked],
  };

  return {
    controls,
    handle,
    reset() {
      installations.clear();
      repositories.clear();
      pullRequests.clear();
      permissions.clear();
      omitted.clear();
      rawInstallationRecords.length = 0;
      tokens.clear();
      issuedTokens.length = 0;
      revoked.length = 0;
      tokenRequests.length = 0;
      jwtsRejected = false;
      tokenAnswerPatch = null;
      appPermissions = { ...DEFAULT_FAKE_APP_PERMISSIONS };
    },
  };
}
