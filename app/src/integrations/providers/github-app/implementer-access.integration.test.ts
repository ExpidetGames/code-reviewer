// SPDX-License-Identifier: LicenseRef-Proprietary

// The token the Implementer pushes with (#749) and the check whether an installation has accepted the write
// permission. The provider and the real client run against the fake GitHub over real HTTP; the fake holds the
// permissions of the App and, separately, those the installation accepted, so a raised permission that the owner of
// the installation has not approved yet refuses the token like GitHub does (422).
import { describe, expect, it } from "vitest";
import type { FakePermissions } from "../../../../../fakes/github/app-api.ts";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { startGithubAppHarness } from "../../../test-support/github-app-harness.ts";
import { IntegrationError } from "../../errors.ts";
import { isGitAccess } from "../../normalized.ts";
import type { RepoRef } from "../../types.ts";
import { createGithubAppClient } from "./client.ts";
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

const READ_ONLY: FakePermissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "write",
  checks: "write",
};
const WITH_WRITE: FakePermissions = { ...READ_ONLY, contents: "write" };

/** An App that already asks for contents write; the installation has accepted what `accepted` says. */
async function setup(accepted: FakePermissions = WITH_WRITE) {
  const harness = await startGithubAppHarness();
  const { fake, env } = harness;
  fake.setAppPermissions(WITH_WRITE);
  fake.addInstallation({ id: 4242, account: ACME });
  fake.setInstallationPermissions(4242, accepted);
  fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  const provider = createGithubAppProvider({
    config: () => loadGithubAppConfig(env),
    clientOptions: { now: harness.clock.now },
  });
  return { fake, provider, env };
}

async function failureOf(run: Promise<unknown>): Promise<IntegrationError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(IntegrationError);
  return error as IntegrationError;
}

describe("the token of the Implementer", () => {
  // #749-T05
  it("returns a token, the API base URL and the bot login for a repository of the installation", async () => {
    const { fake, provider } = await setup();

    const access = await provider.implementerAccess(integration, widgets);

    expect(isGitAccess(access)).toBe(true);
    expect(access).toMatchObject({
      provider: "github",
      baseUrl: fake.baseUrl,
      authType: "token",
      botLogin: "code-reviewer-test[bot]",
    });
    expect(access.token).toBe(fake.issuedInstallationTokens()[0]);
  });

  // #749-T04
  // #749-T05
  it("asks for contents write and metadata read on the one repository, and nothing else", async () => {
    const { fake, provider } = await setup();

    await provider.implementerAccess(integration, widgets);

    expect(fake.tokenRequests()).toEqual([
      expect.objectContaining({
        installationId: 4242,
        repositoryIds: [7001],
        repositories: null,
        permissions: { contents: "write", metadata: "read" },
      }),
    ]);
  });

  // #749-T05 (the fake enforces what the request asked for)
  it("issues a token that reaches that repository only", async () => {
    const { fake, provider } = await setup();

    const access = await provider.implementerAccess(integration, widgets);

    const response = await fetch(`${fake.baseUrl}/installation/repositories`, {
      headers: { authorization: `Bearer ${access.token}` },
    });
    const body = (await response.json()) as {
      repositories: { full_name: string }[];
    };
    expect(response.status).toBe(200);
    expect(body.repositories.map((repo) => repo.full_name)).toEqual([
      "acme/widgets",
    ]);
  });

  // #749-T05
  it("creates a new token for every call", async () => {
    const { fake, provider } = await setup();

    const first = await provider.implementerAccess(integration, widgets);
    const second = await provider.implementerAccess(integration, widgets);

    expect(first.token).not.toBe(second.token);
    expect(fake.tokenRequests()).toHaveLength(2);
  });

  // #749-T05
  it("fails with its own code, not retryable, and issues nothing, when the installation has not accepted contents write", async () => {
    const { fake, provider } = await setup(READ_ONLY);

    const error = await failureOf(
      provider.implementerAccess(integration, widgets),
    );

    expect(error).toMatchObject({
      code: "INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED",
      retryable: false,
    });
    expect(fake.issuedInstallationTokens()).toEqual([]);
  });

  // #749-T05
  it("fails the same way when the App itself still asks for contents read only", async () => {
    const { fake, provider } = await setup();
    fake.setAppPermissions(READ_ONLY);

    expect(
      (await failureOf(provider.implementerAccess(integration, widgets))).code,
    ).toBe("INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED");
    expect(fake.issuedInstallationTokens()).toEqual([]);
  });

  // #749-T05
  it("works as soon as the installation accepts the permission", async () => {
    const { fake, provider } = await setup(READ_ONLY);
    await failureOf(provider.implementerAccess(integration, widgets));

    fake.setInstallationPermissions(4242, WITH_WRITE);

    expect(
      isGitAccess(await provider.implementerAccess(integration, widgets)),
    ).toBe(true);
  });

  // #749-T05
  it("keeps the scope refused code for a repository the installation does not have", async () => {
    const { fake, provider } = await setup();
    fake.removeRepository(4242, 7001);

    expect(
      (await failureOf(provider.implementerAccess(integration, widgets))).code,
    ).toBe("INTEGRATION_ACCESS_SCOPE_REFUSED");
    expect(fake.issuedInstallationTokens()).toEqual([]);
  });

  // #749-T04 (the existing guards, for this token)
  it("refuses an empty, foreign or unusable repository reference without asking GitHub anything", async () => {
    const { fake, provider } = await setup();

    for (const repo of [
      { ...widgets, externalId: "" },
      { ...widgets, externalId: "7001/../1" },
      { ...widgets, externalId: "0" },
      { ...widgets, externalId: "9007199254740993" },
      { ...widgets, integrationId: "another-integration" },
    ])
      expect(
        (await failureOf(provider.implementerAccess(integration, repo))).code,
      ).toBe("INTEGRATION_ACCESS_SCOPE_REFUSED");
    expect(fake.requests()).toEqual([]);
  });

  // #749-T04 (the one place that mints refuses a request without a repository)
  it("is minted by the client, which refuses a scope without a repository before any request", async () => {
    const { fake, env } = await setup();
    const client = createGithubAppClient({ config: loadGithubAppConfig(env) });

    await expect(
      client.mintInstallationToken("4242", {
        repositoryIds: [],
        permissions: { contents: "write", metadata: "read" },
      }),
    ).rejects.toMatchObject({ code: "GITHUB_APP_REQUEST_FAILED" });
    expect(fake.requests()).toEqual([]);
  });
});

describe("what the installation holds", () => {
  // #749-T06
  it("says contents write is not granted for an installation with contents read", async () => {
    const { provider } = await setup(READ_ONLY);

    expect(await provider.installationPermissions(integration)).toEqual({
      contentsWrite: false,
    });
  });

  // #749-T06
  it("says it is granted once the installation accepts it", async () => {
    const { fake, provider } = await setup(READ_ONLY);

    fake.setInstallationPermissions(4242, WITH_WRITE);

    expect(await provider.installationPermissions(integration)).toEqual({
      contentsWrite: true,
    });
  });

  // #749-T06
  it("says it is not granted for an installation without any contents permission", async () => {
    const { fake, provider } = await setup();
    fake.setInstallationPermissions(4242, { metadata: "read" });

    expect(await provider.installationPermissions(integration)).toEqual({
      contentsWrite: false,
    });
  });

  // #749-T06
  it("reads the installation and mints no token", async () => {
    const { fake, provider } = await setup(READ_ONLY);

    await provider.installationPermissions(integration);

    expect(fake.issuedInstallationTokens()).toEqual([]);
    expect(fake.requests().map((request) => request.path)).toEqual([
      "/app/installations/4242",
    ]);
  });

  // #749-T06
  it("reports a removed installation with the connection gone code", async () => {
    const { fake, provider } = await setup();
    fake.removeInstallation(4242);

    expect(
      (await failureOf(provider.installationPermissions(integration))).code,
    ).toBe("INTEGRATION_ACCESS_CONNECTION_GONE");
  });
});
