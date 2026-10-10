// Pins down the GitHub client against the fake GitHub API over real HTTP: what it reads, how it
// pages, which token it uses, and that every failure becomes a stable code without a secret in it.
import { describe, expect, it } from "vitest";
import type { FakeGithubApp } from "../../../../../fakes/github/app-api.ts";
import { startGithubAppHarness } from "../../../test-support/github-app-harness.ts";
import { createGithubAppClient, type GithubAppClient } from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

async function setup(options: { requestTimeoutMs?: number } = {}) {
  const harness = await startGithubAppHarness();
  const { fake, clock, env } = harness;
  fake.addInstallation({ id: 4242, account: ACME });
  fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  const client = createGithubAppClient({
    config: loadGithubAppConfig(env),
    now: clock.now,
    ...options,
  });
  return { fake, clock, client };
}

async function failureOf(run: Promise<unknown>): Promise<GithubAppError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GithubAppError);
  return error as GithubAppError;
}

describe("listing installations", () => {
  it("reads the account and the suspended flag of every installation", async () => {
    const { fake, client } = await setup();
    fake.addInstallation({
      id: 4300,
      account: { login: "octocat", id: 583231, type: "User" },
      suspended: true,
    });

    const installations = await client.listInstallations();

    expect(installations).toEqual([
      {
        id: "4242",
        accountLogin: "acme",
        accountId: 5001,
        accountType: "Organization",
        suspended: false,
      },
      {
        id: "4300",
        accountLogin: "octocat",
        accountId: 583231,
        accountType: "User",
        suspended: true,
      },
    ]);
  });

  it("reads all pages", async () => {
    const { fake, client } = await setup();
    for (let id = 5000; id < 5130; id += 1)
      fake.addInstallation({
        id,
        account: { login: `org${id}`, id, type: "Organization" },
      });

    const installations = await client.listInstallations();

    expect(installations).toHaveLength(131);
    expect(new Set(installations.map((item) => item.id)).size).toBe(131);
  });

  it("returns null for an installation GitHub does not know", async () => {
    const { client } = await setup();

    expect(await client.getInstallation("9999")).toBeNull();
    expect(await client.getInstallation("4242")).toMatchObject({
      id: "4242",
      accountLogin: "acme",
    });
  });
});

describe("listing the repositories of an installation", () => {
  it("returns the id, full name and web URL of each repository", async () => {
    const { client } = await setup();

    const repos = await client.listInstallationRepositories("4242");

    expect(repos).toEqual([
      {
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
      {
        externalId: "7002",
        fullName: "acme/gadgets",
        url: "https://github.test/acme/gadgets",
      },
    ]);
  });

  it("reads every page of a large installation", async () => {
    const { fake, client } = await setup();
    fake.setRepositories(
      4242,
      Array.from({ length: 250 }, (_, index) => ({
        id: 10_000 + index,
        fullName: `acme/repo-${index}`,
      })),
    );

    const repos = await client.listInstallationRepositories("4242");

    expect(repos).toHaveLength(250);
    expect(
      fake.requests().filter((r) => r.path === "/installation/repositories"),
    ).toHaveLength(3);
  });

  it("reuses the installation token until it is about to expire", async () => {
    const { fake, clock, client } = await setup();

    await client.listInstallationRepositories("4242");
    await client.listInstallationRepositories("4242");
    expect(fake.issuedInstallationTokens()).toHaveLength(1);

    clock.advance(59 * 60 * 1000 + 30_000);
    await client.listInstallationRepositories("4242");
    expect(fake.issuedInstallationTokens()).toHaveLength(2);
  });

  it("asks for a new token once when GitHub refuses the cached one", async () => {
    const { fake, client } = await setup();
    await client.listInstallationRepositories("4242");
    fake.fail({
      pathIncludes: "/installation/repositories",
      status: 401,
      times: 1,
    });

    const repos = await client.listInstallationRepositories("4242");

    expect(repos).toHaveLength(2);
    expect(fake.issuedInstallationTokens()).toHaveLength(2);
  });

  it("fails with a stable code instead of returning a partial list when a later page fails", async () => {
    const { fake, client } = await setup();
    fake.setRepositories(
      4242,
      Array.from({ length: 150 }, (_, index) => ({
        id: index + 1,
        fullName: `acme/repo-${index}`,
      })),
    );
    fake.fail({ queryIncludes: "page=2", status: 500 });

    const error = await failureOf(client.listInstallationRepositories("4242"));

    expect(error).toMatchObject({
      code: "GITHUB_APP_UNAVAILABLE",
      status: 500,
    });
  });
});

describe("failures", () => {
  // CR-21-T13
  it("maps a refused App JWT to an auth error that carries no credential", async () => {
    const { fake, client } = await setup();
    fake.rejectAppJwts(true);

    const error = await failureOf(client.listInstallations());

    expect(error).toMatchObject({
      code: "GITHUB_APP_AUTH_FAILED",
      status: 401,
    });
    for (const credential of fake.seenCredentials())
      expect(error.message).not.toContain(credential);
  });

  it("maps a server error to unavailable", async () => {
    const { fake, client } = await setup();
    fake.fail({ status: 503 });

    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_UNAVAILABLE",
      status: 503,
    });
  });

  it("maps a request that takes too long to unavailable", async () => {
    const { fake, client } = await setup({ requestTimeoutMs: 100 });
    fake.fail({ delayMs: 1500 });

    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_UNAVAILABLE",
      status: null,
    });
  });

  it("maps a rate limit to a code with the time to wait", async () => {
    const { fake, client } = await setup();
    fake.fail({ status: 429, headers: { "retry-after": "30" }, times: 1 });
    fake.fail({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "retry-after": "12" },
      times: 1,
    });

    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
      retryAfterSeconds: 30,
    });
    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
      retryAfterSeconds: 12,
    });
  });

  it("maps a plain 403 to forbidden and an unexpected status to a failed request", async () => {
    const { fake, client } = await setup();
    fake.fail({ status: 403, times: 1 });
    fake.fail({ status: 418, times: 1 });

    expect((await failureOf(client.listInstallations())).code).toBe(
      "GITHUB_APP_FORBIDDEN",
    );
    expect((await failureOf(client.listInstallations())).code).toBe(
      "GITHUB_APP_REQUEST_FAILED",
    );
  });

  it("refuses an installation id that is not a number before any request", async () => {
    const { fake, client } = await setup();

    const error = await failureOf(
      client.listInstallationRepositories("4242/../1"),
    );

    expect(error.code).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(fake.requests()).toEqual([]);
  });
});

describe("pull requests", () => {
  async function withPullRequests(): Promise<{
    client: GithubAppClient;
    fake: FakeGithubApp;
  }> {
    const { fake, client } = await setup();
    fake.addPullRequest("acme/widgets", {
      number: 7,
      title: "Add widget caching",
      state: "open",
      headSha: "abc123",
      headRef: "feature/caching",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    fake.addPullRequest("acme/widgets", {
      number: 8,
      title: "Work in progress",
      state: "open",
      draft: true,
      headSha: "def456",
      headRef: "wip",
      baseRef: "main",
      author: { login: "bob", id: 1002 },
    });
    fake.addPullRequest("acme/widgets", {
      number: 9,
      title: "Old change",
      state: "closed",
      merged: true,
      headSha: "0a0a0a",
      headRef: "old",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    return { client, fake };
  }

  it("reads one pull request in the normalized shape", async () => {
    const { client } = await withPullRequests();

    expect(await client.getPullRequest("4242", "acme/widgets", 7)).toEqual({
      number: 7,
      title: "Add widget caching",
      url: "https://github.test/acme/widgets/pull/7",
      headSha: "abc123",
      baseRef: "main",
      headRef: "feature/caching",
      draft: false,
      state: "open",
      author: { login: "alice", externalId: "1001" },
    });
  });

  it("marks drafts and merged pull requests", async () => {
    const { client } = await withPullRequests();

    expect(
      await client.getPullRequest("4242", "acme/widgets", 8),
    ).toMatchObject({ draft: true, state: "open" });
    expect(
      await client.getPullRequest("4242", "acme/widgets", 9),
    ).toMatchObject({ draft: false, state: "merged" });
  });

  it("lists only the open pull requests, drafts included", async () => {
    const { client } = await withPullRequests();

    const open = await client.listOpenPullRequests("4242", "acme/widgets");

    expect(open.map((pr) => pr.number)).toEqual([7, 8]);
  });

  it("reports an unknown pull request as not found", async () => {
    const { client } = await withPullRequests();

    expect(
      await failureOf(client.getPullRequest("4242", "acme/widgets", 99)),
    ).toMatchObject({ code: "GITHUB_APP_NOT_FOUND", status: 404 });
  });
});

describe("collaborator permissions", () => {
  it("returns the permission of a user and none for a user without access", async () => {
    const { fake, client } = await setup();
    fake.setCollaboratorPermission("acme/widgets", "bob", "write");

    expect(
      await client.getCollaboratorPermission("4242", "acme/widgets", "Bob"),
    ).toBe("write");
    expect(
      await client.getCollaboratorPermission("4242", "acme/widgets", "mallory"),
    ).toBe("none");
  });
});

describe("minting an installation token", () => {
  it("narrows the token to the named repositories", async () => {
    const { fake, client } = await setup();

    const token = await client.mintInstallationToken("4242", {
      repositoryNames: ["widgets"],
    });

    expect(token.token).toMatch(/^ghs_/);
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now() - 1);
    expect(fake.tokenRequests()).toEqual([
      { installationId: 4242, repositories: ["widgets"] },
    ]);
  });

  it("never reuses a token from the cache for a job", async () => {
    const { fake, client } = await setup();

    await client.mintInstallationToken("4242");
    await client.mintInstallationToken("4242");

    expect(fake.issuedInstallationTokens()).toHaveLength(2);
  });

  it("fails for a repository the installation cannot access and for a suspended installation", async () => {
    const { fake, client } = await setup();

    expect(
      await failureOf(
        client.mintInstallationToken("4242", { repositoryNames: ["nope"] }),
      ),
    ).toMatchObject({ code: "GITHUB_APP_REQUEST_FAILED", status: 422 });

    fake.suspendInstallation(4242, true);
    expect((await failureOf(client.mintInstallationToken("4242"))).code).toBe(
      "GITHUB_APP_FORBIDDEN",
    );
  });
});
