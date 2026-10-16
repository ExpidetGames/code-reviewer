// SPDX-License-Identifier: Apache-2.0

// An in-memory GithubAppClient for unit tests of the provider: no HTTP, no GitHub. It answers from
// plain data and records every call. (The real client is tested against the fake GitHub API.)
import type {
  CollaboratorPermission,
  GithubAppClient,
  IssueComment,
  RemoteInstallation,
  RemoteRepository,
} from "./client.ts";
import { GithubAppError } from "./errors.ts";
import type { PullRequestRef } from "../../types.ts";

export type FakeGithubAppClientData = {
  installations?: RemoteInstallation[];
  repositories?: Record<string, RemoteRepository[]>;
  /** Pull requests by "owner/name". */
  pullRequests?: Record<string, PullRequestRef[]>;
  /** Permissions by "owner/name#login". */
  permissions?: Record<string, CollaboratorPermission>;
  token?: { token: string; expiresAt: string };
  /** Makes `mintInstallationToken` reject with this error. */
  mintFailure?: Error;
  /** Makes `listOpenPullRequests` reject with this error. */
  listPullRequestsFailure?: Error;
  /** Makes `createIssueComment` reject with this error. */
  commentFailure?: Error;
  /** Makes `listIssueComments` reject with this error. */
  listCommentsFailure?: Error;
  /** What `listIssueComments` answers, by "owner/name#number". */
  comments?: Record<string, IssueComment[]>;
  /** Makes `getPullRequest` reject with this error (an unknown pull request is rejected anyway). */
  getPullRequestFailure?: Error;
};

export type FakeGithubAppClient = GithubAppClient & {
  readonly calls: Array<{ method: string; args: unknown[] }>;
};

export const FAKE_PULL_REQUEST: PullRequestRef = {
  number: 7,
  title: "Add widget caching",
  url: "https://github.com/acme/widgets/pull/7",
  headSha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
  baseRef: "main",
  headRef: "feature/caching",
  draft: false,
  state: "open",
  author: { login: "alice", externalId: "1001" },
};

/** Like the real client: a signal that has fired means no request and GITHUB_APP_UNAVAILABLE. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new GithubAppError(
      "GITHUB_APP_UNAVAILABLE",
      "GitHub could not be reached.",
    );
}

export function fakeGithubAppClient(
  data: FakeGithubAppClientData = {},
): FakeGithubAppClient {
  const calls: FakeGithubAppClient["calls"] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args });
  const pullRequests = data.pullRequests ?? {
    "acme/widgets": [FAKE_PULL_REQUEST],
  };

  return {
    calls,
    async getApp() {
      record("getApp");
      return {
        id: "424242",
        slug: "code-reviewer-test",
        owner: { id: 1, login: "acme" },
        permissions: {},
      };
    },
    async listInstallations() {
      record("listInstallations");
      return data.installations ?? [];
    },
    async getInstallation(installationId) {
      record("getInstallation", installationId);
      return (
        (data.installations ?? []).find((item) => item.id === installationId) ??
        null
      );
    },
    async listInstallationRepositories(installationId) {
      record("listInstallationRepositories", installationId);
      return (
        data.repositories?.[installationId] ?? [
          {
            externalId: "7001",
            fullName: "acme/widgets",
            url: "https://github.com/acme/widgets",
          },
        ]
      );
    },
    async getPullRequest(installationId, repoFullName, prNumber, signal) {
      record(
        "getPullRequest",
        installationId,
        repoFullName,
        prNumber,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.getPullRequestFailure) throw data.getPullRequestFailure;
      const found = (pullRequests[repoFullName] ?? []).find(
        (pr) => pr.number === prNumber,
      );
      if (found === undefined)
        throw new GithubAppError("GITHUB_APP_NOT_FOUND", "Not found", {
          status: 404,
        });
      return found;
    },
    async listOpenPullRequests(installationId, repoFullName, signal) {
      record(
        "listOpenPullRequests",
        installationId,
        repoFullName,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.listPullRequestsFailure) throw data.listPullRequestsFailure;
      return (pullRequests[repoFullName] ?? []).filter(
        (pr) => pr.state === "open",
      );
    },
    async getCollaboratorPermission(installationId, repoFullName, login) {
      record("getCollaboratorPermission", installationId, repoFullName, login);
      return data.permissions?.[`${repoFullName}#${login}`] ?? "none";
    },
    async listIssueComments(installationId, scope, repoFullName, prNumber) {
      record(
        "listIssueComments",
        installationId,
        scope,
        repoFullName,
        prNumber,
      );
      if (data.listCommentsFailure) throw data.listCommentsFailure;
      return data.comments?.[`${repoFullName}#${prNumber}`] ?? [];
    },
    async createIssueComment(
      installationId,
      scope,
      repoFullName,
      prNumber,
      body,
    ) {
      record(
        "createIssueComment",
        installationId,
        scope,
        repoFullName,
        prNumber,
        body,
      );
      if (data.commentFailure) throw data.commentFailure;
      return { id: "5001" };
    },
    async mintInstallationToken(installationId, scope) {
      record("mintInstallationToken", installationId, scope);
      if (data.mintFailure) throw data.mintFailure;
      return (
        data.token ?? {
          token: "ghs_unit_test_token",
          expiresAt: "2026-10-10T13:00:00.000Z",
        }
      );
    },
  };
}
