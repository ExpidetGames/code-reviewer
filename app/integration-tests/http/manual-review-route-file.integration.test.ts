// Pins down the real route files `GET /api/repositories/:repositoryId/pull-requests` and
// `POST /api/repositories/:repositoryId/reviews` with the wiring the running server uses: the
// dynamic segment, the database opened at start, the registry configured from the environment (the
// real GitHub App client against the fake GitHub), the project and settings services, the job queue
// and the user check. Only the session lookup and `connection()` are replaced (they need Next.js's
// request scope). The behavior of the handlers is in src/manual-reviews/http.integration.test.ts and
// the proxy in front is in manual-review-route.integration.test.ts; this file proves the pieces are
// connected.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import type { SessionUser } from "../../src/auth/access-policy.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import {
  TEST_APP_ID,
  testAppKeys,
  testGithubAppEnv,
} from "../../src/test-support/github-app.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  requireUser: vi.fn<() => Promise<SessionUser>>(),
}));
vi.mock("@/auth/session", () => ({ requireUser: session.requireUser }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;
const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";
const fakes: FakeGithub[] = [];

async function startRoutes() {
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
  });
  fakes.push(fake);
  const env = testGithubAppEnv({
    GITHUB_API_BASE_URL: fake.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
  });
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) vi.stubEnv(name, value);
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const integration = await createIntegrationsRepository(
    db,
    await defaultWorkspaceId(db),
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(
    db,
    await defaultWorkspaceId(db),
  );
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  fake.addPullRequest("acme/widgets", {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: HEAD,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  // The registry reads the environment on first use, so every test loads the routes anew.
  vi.resetModules();
  const { getProjectService } = await import("../../src/projects/shared.ts");
  await getProjectService().activateProject(repository.id);
  const list =
    await import("../../src/app/api/repositories/[repositoryId]/pull-requests/route.ts");
  const start =
    await import("../../src/app/api/repositories/[repositoryId]/reviews/route.ts");

  function get(repositoryId: string): Promise<Response> {
    return list.GET(
      new Request(
        `https://app.test/api/repositories/${repositoryId}/pull-requests`,
      ),
      { params: Promise.resolve({ repositoryId }) } as Parameters<
        typeof list.GET
      >[1],
    );
  }
  function post(repositoryId: string, body: unknown): Promise<Response> {
    return start.POST(
      new Request(`https://app.test/api/repositories/${repositoryId}/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ repositoryId }) } as Parameters<
        typeof start.POST
      >[1],
    );
  }
  return {
    repository,
    get,
    post,
    jobs: () => db.selectFrom("jobs").selectAll().execute(),
    list,
    start,
  };
}

beforeEach(() => {
  session.requireUser.mockResolvedValue(USER);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describe("the manual start route files", () => {
  // CR-33-T01
  it("lists the open pull requests of the repository named in the address, from GitHub", async () => {
    const { get, repository } = await startRoutes();

    const response = await get(repository.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repositoryId: repository.id,
      pullRequests: [{ number: 7, title: "Add widget caching" }],
    });
  });

  // CR-33-T04
  it("starts a manual job in the real database for the signed in person", async () => {
    const { post, repository, jobs } = await startRoutes();

    const response = await post(repository.id, {
      prNumber: 7,
      command: "review",
    });

    expect(response.status).toBe(201);
    expect(await jobs()).toMatchObject([
      {
        repository_id: repository.id,
        pr_number: 7,
        head_sha: HEAD,
        command: "review",
        trigger_kind: "manual",
        actor_login: "octocat",
        status: "queued",
      },
    ]);
  });

  // CR-33-T11
  it("asks for the user before it reads anything, and a refusal reaches the caller", async () => {
    const { get, post, repository, jobs } = await startRoutes();
    const refusal = new Error("NEXT_REDIRECT");
    session.requireUser.mockRejectedValue(refusal);

    await expect(get(repository.id)).rejects.toBe(refusal);
    await expect(
      post(repository.id, { prNumber: 7, command: "review" }),
    ).rejects.toBe(refusal);

    expect(await jobs()).toEqual([]);
  });

  it("exports only the method each route serves", async () => {
    const { list, start } = await startRoutes();

    expect(Object.keys(list).sort()).toEqual(["GET"]);
    expect(Object.keys(start).sort()).toEqual(["POST"]);
  });
});
