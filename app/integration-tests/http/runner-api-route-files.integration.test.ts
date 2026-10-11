// Pins down the real route files of the runner API with the wiring the running server uses: the
// database opened at start, the registry configured from the environment, the settings read from
// RUNNER_TOKEN and LLM_*. A pull request delivery goes in through the webhook route and comes out
// through claim, heartbeat and complete, so the pieces are proven to be connected. The details of each
// behavior are in runner-api-claim, -report and -security.integration.test.ts.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { initializeDatabaseOnStart } from "../../src/db/startup.ts";
import {
  TEST_APP_ID,
  TEST_WEBHOOK_SECRET,
  testAppKeys,
  testGithubAppEnv,
} from "../../src/test-support/github-app.ts";
import { getProjectService } from "../../src/projects/shared.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

const RUNNER_TOKEN = "route-file-runner-token-91ac-5d2e8b7f0c14";
const LLM_KEY = "route-file-llm-key-77de";
const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

type Webhook = typeof import("../../src/app/api/webhooks/github-app/route.ts");
type Claim = typeof import("../../src/app/api/runners/v1/claim/route.ts");
type Heartbeat =
  typeof import("../../src/app/api/runners/v1/jobs/[id]/heartbeat/route.ts");
type Complete =
  typeof import("../../src/app/api/runners/v1/jobs/[id]/complete/route.ts");

const fakes: FakeGithub[] = [];

async function startRoutes() {
  // The production code reads the real clock, so the fake does too.
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
  });
  fakes.push(fake);
  const env: Record<string, string | undefined> = {
    ...testGithubAppEnv({
      GITHUB_API_BASE_URL: fake.baseUrl,
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    }),
    RUNNER_TOKEN,
    LLM_PROVIDER: "openrouter",
    LLM_API_KEY: LLM_KEY,
    LLM_MODEL: "vendor/test-model",
  };
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) vi.stubEnv(name, value);
  const directory = await createTestDirectory();
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(directory, "app.db") },
  });
  // The registry reads the environment on first use, so every test loads the routes anew.
  vi.resetModules();
  return {
    fake,
    webhook:
      (await import("../../src/app/api/webhooks/github-app/route.ts")) as Webhook,
    claim:
      (await import("../../src/app/api/runners/v1/claim/route.ts")) as Claim,
    heartbeat:
      (await import("../../src/app/api/runners/v1/jobs/[id]/heartbeat/route.ts")) as Heartbeat,
    complete:
      (await import("../../src/app/api/runners/v1/jobs/[id]/complete/route.ts")) as Complete,
  };
}

function runnerRequest(
  action: string,
  body: unknown,
  headers: Record<string, string> = {
    authorization: `Bearer ${RUNNER_TOKEN}`,
    "x-runner-id": "runner-a",
  },
): Request {
  return new Request(`https://app.test/api/runners/v1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describe("the runner API route files", () => {
  it("answers 500 in the usual form, not cacheable, when the server was not set up", async () => {
    const routes = await startRoutes();
    await closeDatabase();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await routes.claim.POST(runnerRequest("claim", undefined));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error.code).toBe("RUNNER_INTERNAL_ERROR");
  });

  it("takes a job that came in through the webhook route from claim to complete", async () => {
    const routes = await startRoutes();
    routes.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    routes.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    routes.fake.addPullRequest("acme/widgets", {
      number: 7,
      title: "Add widget caching",
      state: "open",
      headSha: HEAD,
      headRef: "feature/caching",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    for (const [event, fixture] of [
      ["installation", "installation.created"],
      ["pull_request", "pull_request.opened"],
    ] as const) {
      expect(
        (
          await routes.webhook.POST(
            webhookDelivery({
              event,
              payload: webhookFixture(fixture),
              secret: TEST_WEBHOOK_SECRET,
            }),
          )
        ).status,
      ).toBe(202);
      if (event === "installation") {
        // The repository must be a project before its pull requests are reviewed.
        const [repository] = await createRepositoriesRepository(
          getDatabase(),
          await defaultWorkspaceId(getDatabase()),
        ).list();
        await getProjectService().activateProject(repository!.id);
      }
    }

    const claim = await routes.claim.POST(runnerRequest("claim", undefined));

    expect(claim.status).toBe(200);
    expect(claim.headers.get("cache-control")).toBe("no-store");
    const { job } = await claim.json();
    expect(job.input).toMatchObject({
      prUrl: "https://github.test/acme/widgets/pull/7",
      command: "review",
      llm: {
        provider: "openrouter",
        model: "vendor/test-model",
        apiKey: LLM_KEY,
      },
    });
    expect(job.input.git.token).toMatch(/^ghs_fake/);

    const context = { params: Promise.resolve({ id: job.id }) };
    const beat = await routes.heartbeat.POST(
      runnerRequest(`jobs/${job.id}/heartbeat`, { leaseToken: job.leaseToken }),
      context,
    );
    const done = await routes.complete.POST(
      runnerRequest(`jobs/${job.id}/complete`, {
        leaseToken: job.leaseToken,
        result: {
          ok: true,
          durationMs: 1200,
          commentUrl: null,
          errorCode: null,
          logTail: "done",
        },
      }),
      context,
    );

    expect([beat.status, done.status]).toStrictEqual([200, 200]);
    expect(
      await getDatabase().selectFrom("jobs").select("status").execute(),
    ).toStrictEqual([{ status: "succeeded" }]);
  });

  it("refuses every route without the runner token and says 204 when nothing is waiting", async () => {
    const routes = await startRoutes();
    const noToken = { "x-runner-id": "runner-a" };
    const id = "11111111-2222-4333-8444-555555555555";
    const context = { params: Promise.resolve({ id }) };

    const answers = [
      await routes.claim.POST(runnerRequest("claim", undefined, noToken)),
      await routes.heartbeat.POST(
        runnerRequest(`jobs/${id}/heartbeat`, {}, noToken),
        context,
      ),
      await routes.complete.POST(
        runnerRequest(`jobs/${id}/complete`, {}, noToken),
        context,
      ),
    ];
    const none = await routes.claim.POST(runnerRequest("claim", undefined));

    expect(answers.map((answer) => answer.status)).toStrictEqual([
      401, 401, 401,
    ]);
    expect(none.status).toBe(204);
  });
});
