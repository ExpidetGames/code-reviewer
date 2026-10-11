// Pins down the real route file `POST /api/integrations/sync` with the wiring the running server
// uses: the database opened at start, the process-wide sync service and the registry configured from
// the environment. Only the session lookup and `connection()` are replaced (they need Next.js's
// request scope). The behavior of the handler is in src/integrations/sync/http.integration.test.ts
// and the proxy in front is in sync-route.integration.test.ts; this file proves the pieces are
// connected, and that the route uses the shared sync service rather than a new one.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import type { SessionUser } from "../../src/auth/access-policy.ts";
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
import {
  defaultWorkspaceId,
  markInstanceSetUp,
} from "../../src/test-support/workspaces.ts";

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
const fakes: FakeGithub[] = [];

async function startRoute() {
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
  // A deployment that is in use has been set up (the first-run setup decides about workspaces).
  await markInstanceSetUp(getDatabase());
  // The registry reads the environment on first use, so every test loads the route anew.
  vi.resetModules();
  const route = await import("../../src/app/api/integrations/sync/route.ts");
  return { route, fake };
}

function post(route: { POST: (request: Request) => Promise<Response> }) {
  return route.POST(
    new Request("https://app.test/api/integrations/sync", { method: "POST" }),
  );
}

beforeEach(() => {
  session.requireUser.mockResolvedValue(USER);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describe("the sync route file", () => {
  // CR-21-T03
  it("reads the installations from GitHub into the real database", async () => {
    const { route, fake } = await startRoute();
    fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

    const response = await post(route);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 1, errors: [] });
    expect(
      (
        await createRepositoriesRepository(
          getDatabase(),
          await defaultWorkspaceId(getDatabase()),
        ).list()
      ).map((repo) => repo.fullName),
    ).toEqual(["acme/widgets"]);
  });

  // CR-21-T11, CR-21-T12
  it("asks for the user before it calls GitHub, and a refusal reaches the caller", async () => {
    const { route, fake } = await startRoute();
    const refusal = new Error("NEXT_REDIRECT");
    session.requireUser.mockRejectedValue(refusal);

    await expect(post(route)).rejects.toBe(refusal);

    expect(session.requireUser).toHaveBeenCalled();
    expect(fake.requests()).toEqual([]);
  });

  it("exports only the POST method", async () => {
    const { route } = await startRoute();

    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });
});
