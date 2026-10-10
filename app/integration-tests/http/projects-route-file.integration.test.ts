// Pins down the real route file `PUT /api/repositories/:repositoryId/project` with the wiring the
// running server uses: the dynamic segment, the database opened at start, the project service and the
// user check. Only the session lookup and `connection()` are replaced (they need Next.js's request
// scope). The behavior of the handler is in src/projects/http.integration.test.ts and the proxy in
// front is in projects-route.integration.test.ts; this file proves the pieces are connected.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/auth/access-policy.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { PUT } from "../../src/app/api/repositories/[repositoryId]/project/route.ts";

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

async function startRoute() {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const integration = await createIntegrationsRepository(db).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "1",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");

  function put(repositoryId: string, body: unknown): Promise<Response> {
    return PUT(
      new Request(`https://app.test/api/repositories/${repositoryId}/project`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ repositoryId }) } as Parameters<
        typeof PUT
      >[1],
    );
  }
  return {
    repository,
    put,
    projectRows: () => db.selectFrom("projects").selectAll().execute(),
  };
}

beforeEach(() => {
  session.requireUser.mockResolvedValue(USER);
});

afterEach(async () => {
  await closeDatabase();
});

describe("the project route file", () => {
  // CR-24-T01, CR-24-T02
  it("activates and deactivates the repository named in the address, in the real database", async () => {
    const { put, repository, projectRows } = await startRoute();

    const on = await put(repository.id, { active: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      repositoryId: repository.id,
      active: true,
    });
    expect(await projectRows()).toMatchObject([
      { repository_id: repository.id, active: 1 },
    ]);

    const off = await put(repository.id, { active: false });
    expect(off.status).toBe(200);
    expect(await projectRows()).toMatchObject([
      { repository_id: repository.id, active: 0 },
    ]);
  });

  // CR-24-T09
  it("answers 404 for an unknown repository and creates nothing", async () => {
    const { put, projectRows } = await startRoute();

    const response = await put("no-such-repository", { active: true });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "PROJECT_REPOSITORY_NOT_FOUND",
    });
    expect(await projectRows()).toEqual([]);
  });

  // CR-24-T10, CR-24-T11
  it("asks for the user before it reads anything, and a refusal reaches the caller", async () => {
    const { put, repository, projectRows } = await startRoute();
    const refusal = new Error("NEXT_REDIRECT");
    session.requireUser.mockRejectedValue(refusal);

    await expect(put(repository.id, { active: true })).rejects.toBe(refusal);

    expect(session.requireUser).toHaveBeenCalled();
    expect(await projectRows()).toEqual([]);
  });

  it("exports only the PUT method", async () => {
    const route =
      await import("../../src/app/api/repositories/[repositoryId]/project/route.ts");

    expect(Object.keys(route).sort()).toEqual(["PUT"]);
  });
});
