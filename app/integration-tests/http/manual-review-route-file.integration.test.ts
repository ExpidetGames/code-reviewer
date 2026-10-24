// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files `GET /api/w/:workspace/repositories/:repositoryId/pull-requests` and
// `POST /api/w/:workspace/repositories/:repositoryId/reviews` with the wiring the running server uses: the
// dynamic segments, the database opened at start, the registry configured from the environment (the real
// GitHub App client against the fake GitHub), the project and settings services, the job queue and the
// workspace access. Only the session lookup and `connection()` are replaced (they need Next.js's request
// scope). The behavior of the handlers is in src/manual-reviews/http.integration.test.ts and the proxy in
// front is in manual-review-route.integration.test.ts; this file proves the pieces are connected, that
// every member may start a review, and that the workspace is the one in the address.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import type { SessionLookup } from "../../src/auth/session-user.ts";
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
import { saveGithubAppFromEnv } from "../../src/test-support/server-credentials.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

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
  await saveGithubAppFromEnv(db, env);
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
  const workspaceId = await defaultWorkspaceId(db);
  const { projectServiceFor } = await import("../../src/projects/shared.ts");
  await projectServiceFor(workspaceId).activateProject(repository.id);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      workspaceId,
      role: "member",
      githubLogin: "octocat",
    }),
  );
  const list =
    await import("../../src/app/api/w/[workspace]/repositories/[repositoryId]/pull-requests/route.ts");
  const start =
    await import("../../src/app/api/w/[workspace]/repositories/[repositoryId]/reviews/route.ts");

  function get(repositoryId: string, workspace = "default"): Promise<Response> {
    return list.GET(
      new Request(
        `https://app.test/api/w/${workspace}/repositories/${repositoryId}/pull-requests`,
      ),
      { params: Promise.resolve({ workspace, repositoryId }) } as Parameters<
        typeof list.GET
      >[1],
    );
  }
  function post(
    repositoryId: string,
    body: unknown,
    workspace = "default",
  ): Promise<Response> {
    return start.POST(
      new Request(
        `https://app.test/api/w/${workspace}/repositories/${repositoryId}/reviews`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ workspace, repositoryId }) } as Parameters<
        typeof start.POST
      >[1],
    );
  }
  return {
    db,
    repository,
    get,
    post,
    jobs: () => db.selectFrom("jobs").selectAll().execute(),
    list,
    start,
  };
}

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

  // #101-WM-06, #101-WM-07
  it("answers a person who does not belong to the workspace like for a workspace that does not exist, and starts nothing", async () => {
    const { get, post, repository, jobs, db } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const workspace of ["default", "no-such-workspace"]) {
      for (const response of [
        await get(repository.id, workspace),
        await post(
          repository.id,
          { prNumber: 7, command: "review" },
          workspace,
        ),
      ]) {
        expect(response.status, workspace).toBe(404);
        expect(await response.json(), workspace).toEqual({
          error: "not_found",
        });
      }
    }
    expect(await jobs()).toEqual([]);
  });

  // CR-33-T11
  it("asks for the session before it reads anything, and answers a visitor with 401", async () => {
    const { get, post, repository, jobs } = await startRoutes();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    expect((await get(repository.id)).status).toBe(401);
    expect(
      (await post(repository.id, { prNumber: 7, command: "review" })).status,
    ).toBe(401);

    expect(await jobs()).toEqual([]);
  });

  it("exports only the method each route serves", async () => {
    const { list, start } = await startRoutes();

    expect(Object.keys(list).sort()).toEqual(["GET"]);
    expect(Object.keys(start).sort()).toEqual(["POST"]);
  });
});
