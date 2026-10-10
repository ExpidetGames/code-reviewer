// Pins down what happens when syncs and deliveries overlap in time. GitHub's answer is slowed down
// (it reflects the moment the request arrived and reaches the app later), so a sync that is not
// ordered against a delivery, or that trusts an old snapshot, ends in a wrong state. Also pins down
// that a failure for one installation does not stop the others.
import { describe, expect, it, vi } from "vitest";
import { fakeIntegrationProvider } from "../../test-support/fake-integration-provider.ts";
import { startSyncHarness } from "../../test-support/integration-sync-harness.ts";
import { createIntegrationRegistry } from "../registry.ts";
import { createIntegrationSync } from "./service.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";

type Harness = Awaited<ReturnType<typeof startSyncHarness>>;

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

async function requestsTo(h: Harness, path: string, count: number) {
  await vi.waitFor(() =>
    expect(
      h.fake.requests().filter((request) => request.path === path),
    ).toHaveLength(count),
  );
}

describe("overlapping syncs and deliveries", () => {
  // CR-21-T07
  it("ends with GitHub's current list when a slow full sync overlaps a delivery about the same installation", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();
    // The sync's own read will see both repositories, but the answer arrives late.
    h.fake.addRepository(4242, { id: 7002, fullName: "acme/gadgets" });
    h.fake.fail({
      pathIncludes: "/installation/repositories",
      responseDelayMs: 400,
      times: 1,
    });
    const slowSync = h.sync.syncAll();
    await requestsTo(h, "/installation/repositories", 2);

    // Meanwhile GitHub drops the repository again and tells us.
    h.fake.removeRepository(4242, 7002);
    const delivery = h.deliver("installation_repositories.removed");
    await Promise.all([slowSync, delivery]);

    // Whatever order the two ran in, the last one to read saw the current list: only widgets.
    expect(
      (await h.repositories.list({ active: true })).map(
        (repo) => repo.fullName,
      ),
    ).toEqual(["acme/widgets"]);
  });

  it("keeps a row that a delivery created after the sync read its list, instead of disabling it", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({
      id: 4300,
      account: { login: "octocat", id: 583231, type: "User" },
    });
    h.fake.setRepositories(4300, [{ id: 8001, fullName: "octocat/hello" }]);
    h.fake.fail({
      pathIncludes: "/app/installations",
      responseDelayMs: 300,
      times: 1,
    });
    const slowSync = h.sync.syncAll();
    await requestsTo(h, "/app/installations", 1);

    // The list is already on its way; now a new installation appears and its delivery arrives.
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    const delivery = await h.deliver("installation.created");
    await slowSync;

    expect(delivery).toMatchObject({ outcome: "created" });
    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("active");
    expect(
      (await h.repositories.list({ active: true }))
        .map((repo) => repo.fullName)
        .sort(),
    ).toEqual(["acme/widgets", "octocat/hello"]);
  });

  it("does not let an old 'suspended' in the list override a newer state", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();
    h.fake.suspendInstallation(4242, true);
    h.fake.fail({
      pathIncludes: "/app/installations",
      responseDelayMs: 300,
      times: 1,
    });
    const slowSync = h.sync.syncAll();
    await requestsTo(h, "/app/installations", 2);

    // The list says suspended; by the time it arrives GitHub has resumed the installation.
    h.fake.suspendInstallation(4242, false);
    await slowSync;

    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("active");
  });

  it("still disables an installation that is really gone, after asking GitHub about it", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();
    h.fake.removeInstallation(4242);

    await h.sync.syncAll();

    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("disabled");
    expect(await h.repositories.list({ active: true })).toEqual([]);
  });

  it("leaves an unlisted row alone when GitHub cannot say whether it still exists", async () => {
    const h = await startSyncHarness();
    h.fake.addInstallation({ id: 4242, account: ACME });
    h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await h.sync.syncAll();
    h.fake.removeInstallation(4242);
    h.fake.fail({ pathIncludes: "/app/installations/4242", status: 500 });

    const summary = await h.sync.syncAll();

    expect(summary.errors).toContainEqual(
      expect.objectContaining({
        stage: "connection",
        code: "GITHUB_APP_UNAVAILABLE",
      }),
    );
    expect(
      (await h.integrations.findByExternalId("github_app", "4242"))?.status,
    ).toBe("active");
    expect(await h.repositories.list({ active: true })).toHaveLength(1);
  });
});

describe("a failure for one installation", () => {
  it("is reported with the installation's id and does not stop the others", async () => {
    const { db } = await createTestDatabase();
    const base = fakeIntegrationProvider();
    const provider = {
      ...base,
      async discoverConnections() {
        return ["1", "2"].map((externalId) => ({
          externalId,
          displayName: `account-${externalId}`,
          config: { accountLogin: `account-${externalId}`, accountId: 5 },
          suspended: false,
        }));
      },
      async listRepositories(integration: { id: string; externalId: string }) {
        const repo = {
          integrationId: integration.id,
          externalId: "100",
          fullName: "acme/widgets",
          url: "https://github.test/acme/widgets",
        };
        // A value the database refuses, like an unexpected bug while writing the first installation.
        return [
          integration.externalId === "1"
            ? { ...repo, fullName: null as unknown as string }
            : repo,
        ];
      },
    };
    const lines: string[] = [];
    const sync = createIntegrationSync({
      db,
      registry: createIntegrationRegistry({ github_app: provider }),
      log: (line) => lines.push(line),
    });

    const summary = await sync.syncAll();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({
      stage: "repositories",
      message: "The synchronization failed unexpectedly.",
    });
    expect(summary.errors[0]!.integrationId).not.toBeNull();
    expect(lines.join("\n")).toContain(summary.errors[0]!.integrationId);
    expect(summary.repositories.added).toBe(1);
  });
});
