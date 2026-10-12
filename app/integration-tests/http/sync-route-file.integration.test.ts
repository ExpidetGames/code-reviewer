// SPDX-License-Identifier: Apache-2.0

// Pins down the real route file `POST /api/admin/integrations/sync` (the instance admin's synchronization with
// GitHub) with the wiring the running server uses: the database opened at start, the process-wide sync
// service and the registry configured from the environment. Only the admin lookup and `notFound()` are
// replaced (they need Next.js's request scope). The synchronization reads every connection of the instance,
// so it is the instance admin's: a person who owns a workspace and does not run the instance gets the answer
// of a path that does not exist, and GitHub is not called. The behavior of the handler is in
// src/integrations/sync/http.integration.test.ts; this file proves the pieces are connected, that the
// guard is there, and that the route uses the shared sync service rather than a new one.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import { adminAccessOf, type AdminAccess } from "../../src/admin/access.ts";
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
  linkTestInstallation,
  markInstanceSetUp,
} from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  lookupAdmin: vi.fn<() => Promise<AdminAccess>>(),
}));
vi.mock("@/admin/session", () => ({ lookupAdmin: session.lookupAdmin }));
// The 404 of Next.js is a thrown signal; here it is a marker error the test can recognize.
class NotFoundSignal extends Error {}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: () => {
    throw new NotFoundSignal("not found");
  },
}));
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
  // The portal's routes build the settings service: the master key and the address the app is reached at.
  vi.stubEnv("BETTER_AUTH_URL", "https://app.test");
  vi.stubEnv("APP_SECRET", "sync-route-test-secret-0123456789-0123456789");
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  // A deployment that is in use has been set up (the first-run setup decides about workspaces).
  await markInstanceSetUp(getDatabase());
  session.lookupAdmin.mockResolvedValue(
    adminAccessOf(
      await signedInMember(getDatabase(), {
        id: "root",
        isInstanceAdmin: true,
      }),
    ),
  );
  // The registry reads the environment on first use, so every test loads the route anew.
  vi.resetModules();
  const route =
    await import("../../src/app/api/instance-portal/integrations/sync/route.ts");
  return { route, fake };
}

function post(route: { POST: (request: Request) => Promise<Response> }) {
  return route.POST(
    new Request("https://app.test/api/instance-portal/integrations/sync", {
      method: "POST",
    }),
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
    // The installation was linked by a person of the workspace; one that nobody linked is not made a connection.
    await linkTestInstallation(
      getDatabase(),
      await defaultWorkspaceId(getDatabase()),
      { id: "4242", accountLogin: "acme", accountId: 5001 },
    );
    fake.addInstallation({
      id: 4900,
      account: { login: "other", id: 5900, type: "Organization" },
    });
    fake.setRepositories(4900, [{ id: 7900, fullName: "other/secret" }]);

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
    expect(
      await getDatabase()
        .selectFrom("unclaimed_installations")
        .select("installation_id")
        .execute(),
    ).toEqual([{ installation_id: "4900" }]);
  });

  // #101-WM-08
  it("is a path that does not exist for an Owner of a workspace who does not run the instance, and GitHub is not called", async () => {
    const { route, fake } = await startRoute();
    session.lookupAdmin.mockResolvedValue(
      adminAccessOf(
        await signedInMember(getDatabase(), {
          id: "owner-only",
          workspaceId: await defaultWorkspaceId(getDatabase()),
          role: "owner",
        }),
      ),
    );

    await expect(post(route)).rejects.toBeInstanceOf(NotFoundSignal);

    expect(fake.requests()).toEqual([]);
  });

  // #101-WM-08
  it("is a path that does not exist for a Member and for a person without a workspace either", async () => {
    const { route, fake } = await startRoute();
    for (const options of [
      {
        id: "plain-member",
        workspaceId: await defaultWorkspaceId(getDatabase()),
        role: "member" as const,
      },
      { id: "outsider" },
    ]) {
      session.lookupAdmin.mockResolvedValue(
        adminAccessOf(await signedInMember(getDatabase(), options)),
      );

      await expect(post(route)).rejects.toBeInstanceOf(NotFoundSignal);
    }

    expect(fake.requests()).toEqual([]);
  });

  // CR-21-T11, CR-21-T12
  it("asks for the session before it calls GitHub, and answers a visitor with 401", async () => {
    const { route, fake } = await startRoute();
    session.lookupAdmin.mockResolvedValue(adminAccessOf({ kind: "none" }));

    const response = await post(route);

    expect(response.status).toBe(401);
    expect(fake.requests()).toEqual([]);
  });

  it("exports only the POST method", async () => {
    const { route } = await startRoute();

    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });
});
