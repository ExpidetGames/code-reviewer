// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how installations and repositories are kept in line with GitHub: the real provider and
// client talk over HTTP to the fake GitHub API, the tables are a real SQLite file. A failure of the
// platform must never mark anything inactive, and repeating or overlapping syncs must be harmless.
import { describe, expect, it } from "vitest";
import { testAppKeys } from "../../test-support/github-app.ts";
import { startSyncHarness } from "../../test-support/integration-sync-harness.ts";

type Harness = Awaited<ReturnType<typeof startSyncHarness>>;

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;
const OCTOCAT = { login: "octocat", id: 583231, type: "User" } as const;

function seedTwoInstallations(h: Harness) {
  h.fake.addInstallation({ id: 4242, account: ACME });
  h.fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  h.fake.addInstallation({ id: 4300, account: OCTOCAT });
  h.fake.setRepositories(4300, [{ id: 8001, fullName: "octocat/hello" }]);
}

// Sorted, because rows created in the same millisecond have no meaningful order of their own.
async function rows(h: Harness) {
  const integrations = (await h.integrations.list()).sort((a, b) =>
    a.externalId.localeCompare(b.externalId),
  );
  const repositories = (await h.repositories.list()).sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
  return { integrations, repositories };
}

describe("the full sync", () => {
  // CR-21-T01
  it("stores every repository of every installation as active, linked to its installation", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);

    const summary = await h.sync.syncAll();

    expect(summary.errors).toEqual([]);
    expect(summary.integrations.created).toBe(2);
    expect(summary.repositories.added).toBe(3);
    const { integrations, repositories } = await rows(h);
    const idOf = (externalId: string) =>
      integrations.find((item) => item.externalId === externalId)!.id;
    expect(integrations).toMatchObject([
      {
        type: "github_app",
        displayName: "acme",
        externalId: "4242",
        status: "active",
        config: {
          accountLogin: "acme",
          accountId: 5001,
          accountType: "Organization",
        },
      },
      { displayName: "octocat", externalId: "4300", status: "active" },
    ]);
    expect(
      repositories.map((repo) => [
        repo.fullName,
        repo.integrationId,
        repo.active,
      ]),
    ).toEqual([
      ["acme/gadgets", idOf("4242"), true],
      ["acme/widgets", idOf("4242"), true],
      ["octocat/hello", idOf("4300"), true],
    ]);
  });

  // CR-21-T03
  it("reports how many repositories are new when it is run again by hand", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    h.fake.addRepository(4242, { id: 7003, fullName: "acme/gizmos" });

    const summary = await h.sync.syncAll();

    expect(summary.repositories).toMatchObject({ added: 1, unchanged: 3 });
    expect(
      (await h.repositories.list()).map((repo) => repo.fullName),
    ).toContain("acme/gizmos");
  });

  // CR-21-T06
  it("reactivates the same row when a removed repository is added again", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    const before = (await h.repositories.list()).find(
      (repo) => repo.fullName === "acme/gadgets",
    )!;
    h.fake.removeRepository(4242, 7002);
    await h.sync.syncAll();
    expect((await h.repositories.get(before.id))?.active).toBe(false);

    h.fake.addRepository(4242, { id: 7002, fullName: "acme/gadgets" });
    const summary = await h.sync.syncAll();

    expect(summary.repositories.reactivated).toBe(1);
    expect(await h.repositories.get(before.id)).toMatchObject({ active: true });
    expect(await h.repositories.list()).toHaveLength(3);
  });

  // CR-21-T07
  it("ends in the same state when run twice in a row and once at the same time as a webhook", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    const settled = await rows(h);

    await h.sync.syncAll();
    await h.sync.syncAll();
    await Promise.all([
      h.sync.syncAll(),
      h.deliver("installation_repositories.added"),
      h.sync.syncAll(),
    ]);

    expect(await rows(h)).toEqual(settled);
  });

  it("creates each installation once when two syncs start on an empty database together", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);

    const [first, second] = await Promise.all([
      h.sync.syncAll(),
      h.sync.syncAll(),
    ]);

    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    const { integrations, repositories } = await rows(h);
    expect(integrations).toHaveLength(2);
    expect(repositories).toHaveLength(3);
  });

  // CR-21-T08
  it("stores all 250 repositories of an installation that GitHub lists on several pages", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(
      4242,
      Array.from({ length: 250 }, (_, index) => ({
        id: 10_000 + index,
        fullName: `acme/repo-${index}`,
      })),
    );

    const summary = await h.sync.syncAll();

    expect(summary.errors).toEqual([]);
    expect(await h.repositories.list({ active: true })).toHaveLength(250);
  });

  it("disables an installation that is gone and deactivates its repositories without deleting rows", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    h.fake.removeInstallation(4300);

    const summary = await h.sync.syncAll();

    expect(summary.integrations.disabled).toBe(1);
    const { integrations, repositories } = await rows(h);
    expect(
      integrations.find((item) => item.externalId === "4300")?.status,
    ).toBe("disabled");
    expect(repositories).toHaveLength(3);
    expect(
      repositories.find((repo) => repo.fullName === "octocat/hello")?.active,
    ).toBe(false);
    expect(repositories.filter((repo) => repo.active)).toHaveLength(2);
  });

  it("follows a renamed account and treats a suspended installation as disabled", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    h.fake.addInstallation({
      id: 4242,
      account: { ...ACME, login: "acme-inc" },
      suspended: true,
    });
    const listedBefore = h.fake
      .requests()
      .filter((r) => r.path === "/installation/repositories").length;

    const summary = await h.sync.syncAll();

    expect(summary.integrations).toMatchObject({ updated: 1, disabled: 1 });
    expect(
      await h.integrations.findByExternalId("github_app", "4242"),
    ).toMatchObject({
      displayName: "acme-inc",
      config: { accountLogin: "acme-inc" },
      status: "disabled",
    });
    // Only the other installation is read again.
    expect(
      h.fake.requests().filter((r) => r.path === "/installation/repositories"),
    ).toHaveLength(listedBefore + 1);
  });
});

describe("when GitHub cannot be asked", () => {
  // CR-21-T09
  it("reports a server error and leaves every repository active", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    const before = await rows(h);
    h.fake.fail({ pathIncludes: "/installation/repositories", status: 503 });

    const summary = await h.sync.syncAll();

    expect(summary.errors).toHaveLength(2);
    expect(summary.errors[0]).toMatchObject({
      stage: "repositories",
      code: "GITHUB_APP_UNAVAILABLE",
    });
    expect(summary.repositories.deactivated).toBe(0);
    expect(await rows(h)).toEqual(before);
  });

  // CR-21-T09
  it("reports a timeout and leaves every repository active", async () => {
    const h = await startSyncHarness({ requestTimeoutMs: 150 });
    seedTwoInstallations(h);
    await h.sync.syncAll();
    const before = await rows(h);
    h.fake.fail({ pathIncludes: "/installation/repositories", delayMs: 1500 });

    const summary = await h.sync.syncAll();

    expect(summary.errors.map((error) => error.code)).toEqual([
      "GITHUB_APP_UNAVAILABLE",
      "GITHUB_APP_UNAVAILABLE",
    ]);
    expect(await rows(h)).toEqual(before);
  });

  // CR-21-T09
  it("changes nothing when a later page of the repository list fails", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(
      4242,
      Array.from({ length: 150 }, (_, index) => ({
        id: index + 1,
        fullName: `acme/repo-${index}`,
      })),
    );
    await h.sync.syncAll();
    // Page one alone would look like "repo-149 is gone".
    h.fake.removeRepository(4242, 150);
    h.fake.fail({ queryIncludes: "page=2", status: 500 });

    const summary = await h.sync.syncAll();

    expect(summary.errors).toHaveLength(1);
    expect(await h.repositories.list({ active: true })).toHaveLength(150);
  });

  // CR-21-T09
  it("changes nothing when the list of installations cannot be read", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    const before = await rows(h);
    h.fake.fail({ pathIncludes: "/app/installations", status: 500 });

    const summary = await h.sync.syncAll();

    expect(summary.errors).toEqual([
      expect.objectContaining({
        stage: "discover",
        code: "GITHUB_APP_UNAVAILABLE",
      }),
    ]);
    expect(await rows(h)).toEqual(before);
  });

  it("keeps going with the other installations when one fails", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    h.fake.addRepository(4300, { id: 8002, fullName: "octocat/world" });
    h.fake.removeRepository(4242, 7002);
    h.fake.fail({
      pathIncludes: "/installation/repositories",
      status: 500,
      times: 1,
    });

    const summary = await h.sync.syncAll();

    // Whichever installation was read first failed; the other one was still reconciled.
    expect(summary.errors).toHaveLength(1);
    expect(summary.repositories.added + summary.repositories.deactivated).toBe(
      1,
    );
  });

  it("reports missing GitHub App settings by variable name and writes nothing", async () => {
    const h = await startSyncHarness({ env: { GITHUB_APP_ID: undefined } });
    seedTwoInstallations(h);

    const summary = await h.sync.syncAll();

    expect(summary.errors).toEqual([
      expect.objectContaining({
        stage: "discover",
        code: "GITHUB_APP_CONFIG_INVALID",
        message: expect.stringContaining("GITHUB_APP_ID"),
      }),
    ]);
    expect(await rows(h)).toEqual({ integrations: [], repositories: [] });
    expect(h.fake.requests()).toEqual([]);
  });

  // CR-21-T13
  it("keeps the private key, the JWT and every token out of the result and the log when GitHub refuses the JWT", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    h.fake.rejectAppJwts(true);

    const summary = await h.sync.syncAll();

    expect(summary.errors[0]).toMatchObject({ code: "GITHUB_APP_AUTH_FAILED" });
    const output = JSON.stringify(summary) + h.logged.join("\n");
    const keyBody = testAppKeys().privateKey.split("\n")[1]!;
    expect(output).not.toContain(keyBody);
    expect(output).not.toContain("PRIVATE KEY");
    expect(h.fake.seenCredentials().length).toBeGreaterThan(0);
    for (const credential of [
      ...h.fake.seenCredentials(),
      ...h.fake.issuedInstallationTokens(),
    ])
      expect(output).not.toContain(credential);
  });
});

describe("a delivery about installations", () => {
  // CR-21-T02
  it("adds the new repository as active when repositories were added to an installation", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();
    h.fake.addRepository(4242, { id: 7002, fullName: "acme/gadgets" });

    const result = await h.deliver("installation_repositories.added");

    expect(result).toMatchObject({ outcome: "synced" });
    expect((await rows(h)).repositories).toMatchObject([
      { fullName: "acme/gadgets", active: true },
      { fullName: "acme/widgets", active: true },
    ]);
  });

  // CR-21-T04
  it("marks a removed repository inactive and keeps its row", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    const gadgets = (await h.repositories.list()).find(
      (repo) => repo.fullName === "acme/gadgets",
    )!;
    h.fake.removeRepository(4242, 7002);

    await h.deliver("installation_repositories.removed");

    expect(await h.repositories.get(gadgets.id)).toMatchObject({
      active: false,
      fullName: "acme/gadgets",
    });
    expect(await h.repositories.list()).toHaveLength(3);
  });

  // CR-21-T05
  it("marks every repository of a deleted installation inactive and deletes no row", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    const callsBefore = h.fake.requests().length;

    const result = await h.deliver("installation.deleted");

    expect(result).toMatchObject({ outcome: "deactivated" });
    const { integrations, repositories } = await rows(h);
    expect(repositories).toHaveLength(3);
    expect(
      repositories
        .filter((repo) => repo.fullName.startsWith("acme/"))
        .map((repo) => repo.active),
    ).toEqual([false, false]);
    expect(
      repositories.find((repo) => repo.fullName === "octocat/hello")?.active,
    ).toBe(true);
    expect(
      integrations.find((item) => item.externalId === "4242")?.status,
    ).toBe("disabled");
    expect(h.fake.requests()).toHaveLength(callsBefore);
  });

  it("creates the integration of a new installation after GitHub confirms it exists", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

    const result = await h.deliver("installation.created");

    expect(result).toMatchObject({ outcome: "created" });
    expect(await h.integrations.list()).toMatchObject([
      { externalId: "4242", displayName: "acme", status: "active" },
    ]);
    expect(await h.repositories.list()).toMatchObject([
      { fullName: "acme/widgets", active: true },
    ]);
  });

  it("creates nothing for an installation that GitHub does not know", async () => {
    const h = await startSyncHarness();

    const result = await h.deliver("installation.created");

    expect(result).toMatchObject({ outcome: "installation_not_found" });
    expect(await rows(h)).toEqual({ integrations: [], repositories: [] });
  });

  it("creates nothing and reports the failure when GitHub cannot confirm the installation", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.fail({ pathIncludes: "/app/installations", status: 502 });

    const result = await h.deliver("installation.created");

    expect(result).toMatchObject({ outcome: "failed" });
    expect(result).toMatchObject({
      summary: { errors: [{ code: "GITHUB_APP_UNAVAILABLE" }] },
    });
    expect(await h.integrations.list()).toEqual([]);
  });

  it("ignores the deletion of an installation it never knew", async () => {
    const h = await startSyncHarness();

    expect(await h.deliver("installation.deleted")).toMatchObject({
      outcome: "unknown_installation",
    });
    expect(h.fake.requests()).toEqual([]);
  });

  it("disables an integration when it is suspended and reads its repositories again when it is resumed", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();

    h.fake.suspendInstallation(4242, true);
    expect(await h.deliver("installation.suspend")).toMatchObject({
      outcome: "disabled",
    });
    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("disabled");

    h.fake.suspendInstallation(4242, false);
    h.fake.addRepository(4242, { id: 7003, fullName: "acme/gizmos" });
    expect(await h.deliver("installation.unsuspend")).toMatchObject({
      outcome: "synced",
    });
    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("active");
    expect(await h.repositories.list({ active: true })).toHaveLength(4);
  });

  it("does not suspend an installation because of a late suspend delivery when GitHub says it is active", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();

    const result = await h.deliver("installation.suspend");

    expect(result).toMatchObject({ outcome: "synced" });
    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("active");
  });

  it("does not resume an installation because of a late unsuspend delivery when GitHub says it is suspended", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    h.fake.suspendInstallation(4242, true);
    await h.deliver("installation.suspend");

    const result = await h.deliver("installation.unsuspend");

    expect(result).toMatchObject({ outcome: "skipped_disabled" });
    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("disabled");
  });

  it("does not read the repositories of a suspended installation", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    await h.sync.syncAll();
    h.fake.suspendInstallation(4242, true);
    await h.deliver("installation.suspend");
    const callsBefore = h.fake.requests().length;

    const result = await h.deliver("installation_repositories.added");

    expect(result).toMatchObject({ outcome: "skipped_disabled" });
    expect(h.fake.requests()).toHaveLength(callsBefore);
  });

  it("refuses a delivery with a wrong signature before anything is read", async () => {
    const h = await startSyncHarness();
    seedTwoInstallations(h);
    const provider = h.registry.resolve("github_app");

    const { webhookDelivery, webhookFixture } =
      await import("../../../../fakes/github/webhooks.ts");
    const forged = webhookDelivery({
      event: "installation",
      payload: webhookFixture("installation.deleted"),
      secret: "not-the-secret",
    });

    expect(await provider.verifyWebhook(null, forged)).toBe(false);
    expect(h.fake.requests()).toEqual([]);
  });
});
