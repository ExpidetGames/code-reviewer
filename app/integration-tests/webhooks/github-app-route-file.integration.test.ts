// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route file `POST /api/webhooks/github-app` with the wiring the running server
// uses: the database opened at start, the process-wide sync service, the registry configured from
// the environment, and the job queue intake. The details of each behavior are in
// github-app-route.integration.test.ts; this file proves the pieces are connected.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { projectServiceFor } from "../../src/projects/shared.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { initializeDatabaseOnStart } from "../../src/db/startup.ts";
import { TEST_WEBHOOK_SECRET } from "../../src/test-support/github-app.ts";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import {
  TEST_APP_ID,
  testAppKeys,
  testGithubAppEnv,
} from "../../src/test-support/github-app.ts";
import { saveGithubAppFromEnv } from "../../src/test-support/server-credentials.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import {
  defaultWorkspaceId,
  linkTestInstallation,
  markInstanceSetUp,
} from "../../src/test-support/workspaces.ts";

// #395: the repair work of the requests that touch the database is started by the route; here it is a spy.
const touched = vi.hoisted(() => vi.fn());
vi.mock("../../src/dispatch/maintenance-shared.ts", () => ({
  touched,
  jobEnded: vi.fn(),
}));

type Route = typeof import("../../src/app/api/webhooks/github-app/route.ts");

const fakes: FakeGithub[] = [];

async function startRoute(
  overrides: Record<string, string | undefined> = {},
): Promise<{
  route: Route;
  github: { fake: FakeGithub };
}> {
  // The production code reads the real clock, so the fake does too.
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
  });
  fakes.push(fake);
  const env = testGithubAppEnv({
    GITHUB_API_BASE_URL: fake.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    ...overrides,
  });
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) vi.stubEnv(name, value);
  const directory = await createTestDirectory();
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(directory, "app.db") },
  });
  // A deployment that is in use has been set up (the first-run setup decides about workspaces).
  await markInstanceSetUp(getDatabase());
  await saveGithubAppFromEnv(getDatabase(), env);
  // The registry reads the credentials on first use, so every test loads the route anew.
  vi.resetModules();
  return {
    route: await import("../../src/app/api/webhooks/github-app/route.ts"),
    github: { fake },
  };
}

beforeEach(() => {
  touched.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

// #102-GH-10 (regression): unchanged by the move of the GitHub App into the database.
describe("the webhook route file", () => {
  // #103-IB-11
  it("creates no integration for a new installation nobody linked, notes it as unclaimed and remembers the delivery", async () => {
    const { route, github } = await startRoute();
    github.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    github.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

    const response = await route.POST(
      webhookDelivery({
        event: "installation",
        payload: webhookFixture("installation.created"),
        secret: TEST_WEBHOOK_SECRET,
        deliveryId: "delivery-1",
      }),
    );

    expect(response.status).toBe(202);
    const db = getDatabase();
    expect(await db.selectFrom("integrations").select("id").execute()).toEqual(
      [],
    );
    expect(
      await db
        .selectFrom("unclaimed_installations")
        .select(["installation_id", "source"])
        .execute(),
    ).toEqual([{ installation_id: "4242", source: "webhook" }]);
    expect(
      await db.selectFrom("webhook_deliveries").selectAll().execute(),
    ).toMatchObject([
      { delivery_id: "delivery-1", outcome: "installation_unclaimed" },
    ]);
  });

  it("puts the trigger of a pull request delivery into the job queue", async () => {
    const { route, github } = await startRoute();
    github.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    github.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    // A person of the workspace linked the installation (the binding), then GitHub reports it.
    await linkTestInstallation(
      getDatabase(),
      await defaultWorkspaceId(getDatabase()),
      { id: "4242", accountLogin: "acme", accountId: 5001 },
    );
    await route.POST(
      webhookDelivery({
        event: "installation",
        payload: webhookFixture("installation.created"),
        secret: TEST_WEBHOOK_SECRET,
      }),
    );
    github.fake.addPullRequest("acme/widgets", {
      number: 7,
      title: "Add widget caching",
      state: "open",
      headSha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
      headRef: "feature/caching",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    // The repository must be a project before its pull requests are reviewed.
    const [repository] = await createRepositoriesRepository(
      getDatabase(),
      await defaultWorkspaceId(getDatabase()),
    ).list();
    await projectServiceFor(
      await defaultWorkspaceId(getDatabase()),
    ).activateProject(repository!.id);
    vi.mocked(console.info).mockClear();

    const response = await route.POST(
      webhookDelivery({
        event: "pull_request",
        payload: webhookFixture("pull_request.opened"),
        secret: TEST_WEBHOOK_SECRET,
        deliveryId: "delivery-2",
      }),
    );

    expect(response.status).toBe(202);
    expect(
      await getDatabase()
        .selectFrom("jobs")
        .select([
          "pr_number",
          "head_sha",
          "command",
          "trigger_kind",
          "status",
          "delivery_id",
        ])
        .execute(),
    ).toEqual([
      {
        pr_number: 7,
        head_sha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
        command: "review",
        trigger_kind: "webhook",
        status: "queued",
        delivery_id: "delivery-2",
      },
    ]);
  });

  it("refuses a delivery with a wrong signature and writes nothing", async () => {
    const { route } = await startRoute();

    const response = await route.POST(
      webhookDelivery({
        event: "pull_request",
        payload: webhookFixture("pull_request.opened"),
        secret: "another-secret",
      }),
    );

    expect(response.status).toBe(401);
    expect(
      await getDatabase()
        .selectFrom("webhook_deliveries")
        .selectAll()
        .execute(),
    ).toEqual([]);
  });

  it("refuses deliveries like forged ones when the webhook secret is missing and logs the cause once per process, not once per request", async () => {
    const { route } = await startRoute({
      GITHUB_APP_WEBHOOK_SECRET: undefined,
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const send = () =>
      route.POST(
        webhookDelivery({
          event: "pull_request",
          payload: webhookFixture("pull_request.opened"),
          secret: TEST_WEBHOOK_SECRET,
        }),
      );

    const first = await send();
    const second = await send();

    expect([first.status, second.status]).toEqual([401, 401]);
    expect(await first.json()).toEqual({ error: "WEBHOOK_SIGNATURE_INVALID" });
    const logged = error.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("deliveries cannot be verified"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("github_app_webhook_secret");
  });

  // #97-NOT-CONFIGURED
  it("refuses deliveries and logs no error when no GitHub App variable is set at all, which is the normal state of an instance that is not connected", async () => {
    const { route } = await startRoute({
      GITHUB_APP_ID: undefined,
      GITHUB_APP_SLUG: undefined,
      GITHUB_APP_WEBHOOK_SECRET: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_PATH: undefined,
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await route.POST(
      webhookDelivery({
        event: "pull_request",
        payload: webhookFixture("pull_request.opened"),
        secret: TEST_WEBHOOK_SECRET,
      }),
    );

    expect(response.status).toBe(401);
    expect(
      error.mock.calls.filter((call) =>
        String(call[0]).includes("cannot be verified"),
      ),
    ).toEqual([]);
  });

  it("exports only the POST method", async () => {
    const { route } = await startRoute();

    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });

  describe("the repair work of the requests that touch the database (#395)", () => {
    async function readyRoute() {
      const started = await startRoute();
      started.github.fake.addInstallation({
        id: 4242,
        account: { login: "acme", id: 5001, type: "Organization" },
      });
      started.github.fake.setRepositories(4242, [
        { id: 7001, fullName: "acme/widgets" },
      ]);
      await linkTestInstallation(
        getDatabase(),
        await defaultWorkspaceId(getDatabase()),
        { id: "4242", accountLogin: "acme", accountId: 5001 },
      );
      await started.route.POST(
        webhookDelivery({
          event: "installation",
          payload: webhookFixture("installation.created"),
          secret: TEST_WEBHOOK_SECRET,
        }),
      );
      started.github.fake.addPullRequest("acme/widgets", {
        number: 7,
        title: "Add widget caching",
        state: "open",
        headSha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
        headRef: "feature/caching",
        baseRef: "main",
        author: { login: "alice", id: 1001 },
      });
      const [repository] = await createRepositoriesRepository(
        getDatabase(),
        await defaultWorkspaceId(getDatabase()),
      ).list();
      await projectServiceFor(
        await defaultWorkspaceId(getDatabase()),
      ).activateProject(repository!.id);
      touched.mockClear();
      return started.route;
    }

    const opened = (deliveryId: string) =>
      webhookDelivery({
        event: "pull_request",
        payload: webhookFixture("pull_request.opened"),
        secret: TEST_WEBHOOK_SECRET,
        deliveryId,
      });

    // #395-T11
    it("starts after a delivery that queued a job, once, and not for the same delivery again (a duplicate)", async () => {
      const route = await readyRoute();

      const first = await route.POST(opened("delivery-t11"));
      const again = await route.POST(opened("delivery-t11"));

      expect(await first.json()).toMatchObject({ outcome: "trigger_enqueued" });
      expect(await again.json()).toMatchObject({ outcome: "duplicate" });
      expect(touched).toHaveBeenCalledTimes(1);
    });

    // #395-T11
    it("does not start after a delivery of an event the app does not use, and the response is the same as ever", async () => {
      const route = await readyRoute();

      const response = await route.POST(
        webhookDelivery({
          event: "star",
          payload: { action: "created" },
          secret: TEST_WEBHOOK_SECRET,
          deliveryId: "delivery-star",
        }),
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        status: "accepted",
        outcome: "event_not_used",
      });
      expect(touched).not.toHaveBeenCalled();
    });

    // #395-T11
    it("does not start after a delivery that was refused: a wrong signature, a body that is not JSON", async () => {
      const route = await readyRoute();

      const unsigned = await route.POST(
        webhookDelivery({
          event: "pull_request",
          payload: webhookFixture("pull_request.opened"),
          secret: "not-the-secret-of-this-installation-000000",
          deliveryId: "delivery-bad",
        }),
      );

      expect(unsigned.status).toBe(401);
      expect(touched).not.toHaveBeenCalled();
    });
  });
});
