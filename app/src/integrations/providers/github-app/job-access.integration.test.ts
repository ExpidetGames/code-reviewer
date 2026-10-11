// SPDX-License-Identifier: Apache-2.0

// Pins down the credentials a job gets: a fresh token per call, limited to one repository and the
// least permissions, a stable code for every way it can fail, and no token, JWT or key anywhere it
// should not be. The provider and the real client run against the fake GitHub API over real HTTP;
// the fake enforces the scoping, so these tests prove it instead of just checking the request.
import { inspect } from "node:util";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { startGithubAppHarness } from "../../../test-support/github-app-harness.ts";
import { testAppKeys } from "../../../test-support/github-app.ts";
import { startSyncHarness } from "../../../test-support/integration-sync-harness.ts";
import { IntegrationError } from "../../errors.ts";
import { isGitAccess, revealGitAccess } from "../../normalized.ts";
import type { GitAccess, Integration, RepoRef } from "../../types.ts";
import { loadGithubAppConfig } from "./config.ts";
import { createGithubAppProvider } from "./provider.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

const integration = fakeIntegration({
  id: "integration-1",
  externalId: "4242",
});
const repoRef = (id: number, name: string): RepoRef => ({
  integrationId: "integration-1",
  externalId: String(id),
  fullName: `acme/${name}`,
  url: `https://github.test/acme/${name}`,
});
const widgets = repoRef(7001, "widgets");

async function setup(options: { requestTimeoutMs?: number } = {}) {
  const harness = await startGithubAppHarness();
  const { fake, clock, env } = harness;
  fake.addInstallation({ id: 4242, account: ACME });
  fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  fake.addPullRequest("acme/widgets", {
    number: 7,
    title: "Add caching",
    state: "open",
    headSha: "1f3a5c7e",
    headRef: "feature",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  const provider = createGithubAppProvider({
    config: () => loadGithubAppConfig(env),
    clientOptions: { now: clock.now, ...options },
  });
  return { fake, clock, env, provider };
}

async function failureOf(run: Promise<unknown>): Promise<IntegrationError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(IntegrationError);
  return error as IntegrationError;
}

/** Everything written through console while the test runs. */
function captureLogs(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => inspect(arg, { depth: 6 })).join(" "));
    });
  return lines;
}

async function getAs(token: string, baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
}

describe("job access from the GitHub App", () => {
  // CR-23-T01
  it("returns a token, the API base URL and the bot login of the app for a repository of the installation", async () => {
    const { fake, clock, provider } = await setup();

    const access = await provider.jobAccess(integration, widgets);

    expect(isGitAccess(access)).toBe(true);
    expect(access).toMatchObject({
      provider: "github",
      baseUrl: fake.baseUrl,
      authType: "token",
      botLogin: "code-reviewer-test[bot]",
      expiresAt: new Date(clock.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(access.token).toBe(fake.issuedInstallationTokens()[0]);
  });

  // CR-23-T03
  it("asks for exactly the one repository, never for the whole installation", async () => {
    const { fake, provider } = await setup();

    await provider.jobAccess(integration, widgets);

    expect(fake.tokenRequests()).toEqual([
      expect.objectContaining({
        installationId: 4242,
        repositoryIds: [7001],
        repositories: null,
      }),
    ]);
  });

  // CR-23-T03 (the fake enforces what the request asked for)
  it("issues a token that reaches that repository and no other one of the installation", async () => {
    const { fake, provider } = await setup();

    const access = await provider.jobAccess(integration, widgets);

    expect(
      await getAs(access.token, fake.baseUrl, "/repos/acme/widgets/pulls/7"),
    ).toBe(200);
    expect(
      await getAs(access.token, fake.baseUrl, "/repos/acme/gadgets/pulls"),
    ).toBe(404);
    expect(
      await getAs(access.token, fake.baseUrl, "/installation/repositories"),
    ).toBe(200);
  });

  // CR-23-T04 (lead decision: metadata read is requested explicitly as well)
  it("asks for pull requests and issues write, contents and metadata read, and nothing else", async () => {
    const { fake, provider } = await setup();

    await provider.jobAccess(integration, widgets);

    expect(fake.tokenRequests()[0]?.permissions).toStrictEqual({
      pull_requests: "write",
      issues: "write",
      contents: "read",
      metadata: "read",
    });
  });

  // CR-23-T04
  it("fails with the scope refused code, and issues nothing, when the app is not granted what a job needs", async () => {
    const { fake, provider } = await setup();
    fake.setAppPermissions({
      metadata: "read",
      contents: "read",
      pull_requests: "read",
      issues: "write",
    });

    const error = await failureOf(provider.jobAccess(integration, widgets));

    expect(error.code).toBe("INTEGRATION_ACCESS_SCOPE_REFUSED");
    expect(fake.issuedInstallationTokens()).toEqual([]);
  });

  // CR-23-T05
  it("creates a new token for every call, also for the same repository", async () => {
    const { fake, provider } = await setup();

    const first = await provider.jobAccess(integration, widgets);
    const second = await provider.jobAccess(integration, widgets);

    expect(first.token).not.toBe(second.token);
    expect(fake.issuedInstallationTokens()).toEqual([
      first.token,
      second.token,
    ]);
    expect(fake.tokenRequests()).toHaveLength(2);
  });

  // CR-23-T05 (a read token cached for the sync is not what a job gets)
  it("does not hand a job the token the client keeps for its own reads", async () => {
    const { fake, provider } = await setup();
    await provider.listRepositories(integration);
    const [readToken] = fake.issuedInstallationTokens();

    const access = await provider.jobAccess(integration, widgets);

    expect(access.token).not.toBe(readToken);
    expect(fake.tokenRequests().at(-1)?.repositoryIds).toEqual([7001]);
  });
});

describe("job access that fails", () => {
  // CR-23-T06
  it("reports a deleted installation with the connection gone code and no token", async () => {
    const { fake, provider } = await setup();
    fake.removeInstallation(4242);

    const error = await failureOf(provider.jobAccess(integration, widgets));

    expect(error).toMatchObject({
      code: "INTEGRATION_ACCESS_CONNECTION_GONE",
      retryable: false,
    });
    expect(fake.issuedInstallationTokens()).toEqual([]);
  });

  it("reports a suspended installation with its own code", async () => {
    const { fake, provider } = await setup();
    fake.suspendInstallation(4242, true);

    expect(
      await failureOf(provider.jobAccess(integration, widgets)),
    ).toMatchObject({
      code: "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
      retryable: false,
    });
  });

  // CR-23-T07
  it("refuses a repository that is no longer part of the installation and issues no broader token", async () => {
    const { fake, provider } = await setup();
    fake.removeRepository(4242, 7001);

    const error = await failureOf(provider.jobAccess(integration, widgets));

    expect(error).toMatchObject({
      code: "INTEGRATION_ACCESS_SCOPE_REFUSED",
      retryable: false,
    });
    expect(fake.issuedInstallationTokens()).toEqual([]);
    expect(fake.tokenRequests()).toHaveLength(1);
    expect(fake.tokenRequests()[0]?.repositoryIds).toEqual([7001]);
  });

  it("refuses a repository reference that is not usable before asking GitHub anything", async () => {
    const { fake, provider } = await setup();

    for (const repo of [
      { ...widgets, externalId: "" },
      { ...widgets, externalId: "7001/../1" },
      { ...widgets, externalId: "0" },
      { ...widgets, externalId: "9007199254740993" },
      { ...widgets, integrationId: "another-integration" },
    ])
      expect(
        (await failureOf(provider.jobAccess(integration, repo))).code,
      ).toBe("INTEGRATION_ACCESS_SCOPE_REFUSED");
    expect(fake.requests()).toEqual([]);
  });

  // CR-23-T08
  it("reports a refused App JWT with the app authentication code and no token", async () => {
    const { fake, provider } = await setup();
    fake.rejectAppJwts(true);

    const error = await failureOf(provider.jobAccess(integration, widgets));

    expect(error).toMatchObject({
      code: "INTEGRATION_ACCESS_APP_AUTH_FAILED",
      retryable: false,
    });
    expect(fake.issuedInstallationTokens()).toEqual([]);
  });

  // CR-23-T09
  it("reports a server error as unavailable and retryable", async () => {
    const { fake, provider } = await setup();
    fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });

    expect(
      await failureOf(provider.jobAccess(integration, widgets)),
    ).toMatchObject({
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryable: true,
    });
  });

  // CR-23-T09
  it("reports a rate limit as retryable with the time GitHub asked to wait", async () => {
    const { fake, provider } = await setup();
    fake.fail({
      pathIncludes: "/access_tokens",
      status: 429,
      headers: { "retry-after": "42" },
      times: 1,
    });

    expect(
      await failureOf(provider.jobAccess(integration, widgets)),
    ).toMatchObject({
      code: "INTEGRATION_ACCESS_RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 42,
    });
  });

  // CR-23-T09
  it("reports a request that takes too long as unavailable and retryable", async () => {
    const { fake, provider } = await setup({ requestTimeoutMs: 100 });
    fake.fail({ pathIncludes: "/access_tokens", delayMs: 1500, times: 1 });

    expect(
      await failureOf(provider.jobAccess(integration, widgets)),
    ).toMatchObject({
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryable: true,
    });
  });

  it("passes on the Retry-After of a server error", async () => {
    const { fake, provider } = await setup();
    fake.fail({
      pathIncludes: "/access_tokens",
      status: 503,
      headers: { "retry-after": "17" },
      times: 1,
    });

    expect(
      await failureOf(provider.jobAccess(integration, widgets)),
    ).toMatchObject({ retryable: true, retryAfterSeconds: 17 });
  });

  it("works again on the next call after a retryable failure", async () => {
    const { fake, provider } = await setup();
    fake.fail({ pathIncludes: "/access_tokens", status: 502, times: 1 });
    await failureOf(provider.jobAccess(integration, widgets));

    const access = await provider.jobAccess(integration, widgets);

    expect(access.token).toBe(fake.issuedInstallationTokens()[0]);
  });

  it("does not hand out a token GitHub reports as broader than the one asked for", async () => {
    const { fake, provider } = await setup();
    fake.answerTokensWith({ repository_selection: "all" });

    expect(
      await failureOf(provider.jobAccess(integration, widgets)),
    ).toMatchObject({ code: "INTEGRATION_ACCESS_FAILED", retryable: false });
    expect(fake.revokedInstallationTokens()).toEqual(
      fake.issuedInstallationTokens(),
    );
  });
});

/** Runs every way a job access can end and returns what each of them produced. */
async function everyOutcome() {
  const { fake, provider } = await setup({ requestTimeoutMs: 100 });
  const outputs: string[] = [];
  const access: GitAccess[] = [];
  const attempt = async (prepare: () => void) => {
    fake.clearFailures();
    fake.rejectAppJwts(false);
    prepare();
    try {
      const granted = await provider.jobAccess(integration, widgets);
      access.push(granted);
      outputs.push(
        JSON.stringify(granted),
        inspect(granted, { depth: 6 }),
        String(granted),
        JSON.stringify(Object.entries(granted)),
        JSON.stringify({ ...granted }),
      );
    } catch (error) {
      outputs.push(
        inspect(error, { depth: 8 }),
        String(error),
        error instanceof Error ? (error.stack ?? "") : "",
        JSON.stringify(error),
      );
    }
  };
  await attempt(() => undefined);
  await attempt(() => fake.rejectAppJwts(true));
  await attempt(() => fake.fail({ status: 503, times: 1 }));
  await attempt(() =>
    fake.fail({ status: 429, headers: { "retry-after": "5" }, times: 1 }),
  );
  await attempt(() => fake.fail({ status: 403, times: 1 }));
  await attempt(() => fake.fail({ status: 422, times: 1 }));
  await attempt(() => fake.fail({ delayMs: 1500, times: 1 }));
  await attempt(() => fake.suspendInstallation(4242, true));
  fake.suspendInstallation(4242, false);
  await attempt(() => fake.removeRepository(4242, 7001));
  await attempt(() => fake.removeInstallation(4242));
  return { fake, access, outputs };
}

describe("secrets around job access", () => {
  // CR-23-T10
  it("writes neither a token nor a JWT to any log, for successful and failed calls", async () => {
    const logs = captureLogs();

    const { fake, access } = await everyOutcome();

    const secrets = [
      ...fake.seenCredentials(),
      ...fake.issuedInstallationTokens(),
    ];
    expect(access).toHaveLength(1);
    expect(secrets.length).toBeGreaterThan(2);
    for (const secret of secrets)
      for (const line of logs) expect(line).not.toContain(secret);
  });

  // CR-23-T10 (what an error carries on to a logger)
  it("keeps tokens and JWTs out of GitHub App errors and the access object", async () => {
    const { fake, outputs } = await everyOutcome();

    for (const secret of [
      ...fake.seenCredentials(),
      ...fake.issuedInstallationTokens(),
    ])
      for (const output of outputs) expect(output).not.toContain(secret);
  });

  // CR-23-T12
  it("never exposes the private key or a piece of it, in the access, in errors or in logs", async () => {
    const logs = captureLogs();
    const { privateKey } = testAppKeys();
    const body = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const pieces = new Set<string>([
      privateKey,
      body,
      ...privateKey.split("\n").filter((line) => line.length > 20),
    ]);
    for (let at = 0; at + 32 <= body.length; at += 32)
      pieces.add(body.slice(at, at + 32));

    const { access, outputs } = await everyOutcome();
    const revealed = access.map((item) =>
      JSON.stringify(revealGitAccess(item)),
    );

    for (const piece of pieces)
      for (const text of [...outputs, ...revealed, ...logs])
        expect(text).not.toContain(piece);
  });

  // CR-23-T11
  it("leaves the token in no table of the database, not even after a sync and a job access", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();
    const [row] = await h.integrations.list();
    const [repo] = await h.repositories.list({ active: true });
    expect(row).toBeDefined();
    expect(repo).toBeDefined();

    const access = await h.registry
      .resolve("github_app")
      .jobAccess(row as Integration, {
        integrationId: (row as Integration).id,
        externalId: (repo as { externalId: string }).externalId,
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      });

    const tables = await sql<{ name: string }>`
      select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`.execute(
      h.db,
    );
    expect(tables.rows.length).toBeGreaterThan(1);
    for (const { name } of tables.rows) {
      const dump = await sql
        .raw(`select * from "${name}"`)
        .execute(h.db)
        .then((result) => JSON.stringify(result.rows));
      expect(dump).not.toContain(access.token);
    }
  });
});
