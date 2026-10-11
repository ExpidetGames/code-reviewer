// SPDX-License-Identifier: Apache-2.0

// Pins down the real route file `POST /api/w/:workspace/integrations/sync` with the wiring the running server
// uses: the database opened at start, the process-wide sync service, the registry configured from
// the environment and the workspace access (connections are managed by Admins and Owners). Only the
// session lookup and `connection()` are replaced (they need Next.js's request scope). The behavior of the handler is in src/integrations/sync/http.integration.test.ts
// and the proxy in front is in sync-route.integration.test.ts; this file proves the pieces are
// connected, and that the route uses the shared sync service rather than a new one.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import type { SessionLookup } from "../../src/auth/session-user.ts";
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
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import {
  defaultWorkspaceId,
  markInstanceSetUp,
} from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

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
  const workspaceId = await markInstanceSetUp(getDatabase());
  session.currentLookup.mockResolvedValue(
    await signedInMember(getDatabase(), { workspaceId, role: "admin" }),
  );
  // The registry reads the environment on first use, so every test loads the route anew.
  vi.resetModules();
  const route =
    await import("../../src/app/api/w/[workspace]/integrations/sync/route.ts");
  return { route, fake };
}

function post(
  route: {
    POST: (
      request: Request,
      context: { params: Promise<{ workspace: string }> },
    ) => Promise<Response>;
  },
  workspace = "default",
) {
  return route.POST(
    new Request(`https://app.test/api/w/${workspace}/integrations/sync`, {
      method: "POST",
    }),
    { params: Promise.resolve({ workspace }) },
  );
}

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

  // #101-WM-08
  it("refuses a Member and does not call GitHub: connections are managed by Admins and Owners", async () => {
    const { route, fake } = await startRoute();
    session.currentLookup.mockResolvedValue(
      await signedInMember(getDatabase(), {
        id: "plain-member",
        workspaceId: await defaultWorkspaceId(getDatabase()),
        role: "member",
      }),
    );

    const response = await post(route);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(fake.requests()).toEqual([]);
  });

  // #101-WM-06, #101-WM-07
  it("answers a person who does not belong to the workspace like for a workspace that does not exist, and does not call GitHub", async () => {
    const { route, fake } = await startRoute();
    session.currentLookup.mockResolvedValue(
      await signedInMember(getDatabase(), { id: "outsider" }),
    );

    for (const workspace of ["default", "no-such-workspace"]) {
      const response = await post(route, workspace);
      expect(response.status, workspace).toBe(404);
      expect(await response.json(), workspace).toEqual({ error: "not_found" });
    }
    expect(fake.requests()).toEqual([]);
  });

  // CR-21-T11, CR-21-T12
  it("asks for the session before it calls GitHub, and answers a visitor with 401", async () => {
    const { route, fake } = await startRoute();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const response = await post(route);

    expect(response.status).toBe(401);
    expect(fake.requests()).toEqual([]);
  });

  it("exports only the POST method", async () => {
    const { route } = await startRoute();

    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });
});
