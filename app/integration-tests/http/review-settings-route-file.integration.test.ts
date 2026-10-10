// Pins down the real route files of the review settings with the wiring the running server uses: the
// dynamic segment, the database opened at start, the service on top of it and the user check. Only the
// session lookup and `connection()` are replaced (they need Next.js's request scope). The behavior of
// the handlers is in src/review-settings/http.integration.test.ts and the proxy in front is in
// review-settings-route.integration.test.ts; this file proves the pieces are connected.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../src/auth/access-policy.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { seedRepositories } from "../../src/test-support/review-settings-harness.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import {
  DELETE,
  GET as GET_PROJECT,
  PUT as PUT_PROJECT,
} from "../../src/app/api/repositories/[repositoryId]/project/settings/route.ts";
import {
  GET as GET_GLOBAL,
  PUT as PUT_GLOBAL,
} from "../../src/app/api/review-settings/route.ts";

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

async function startRoutes() {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const { first } = await seedRepositories(db);
  await createProjectsRepository(db).activate(first.id);
  const context = (repositoryId: string) =>
    ({ params: Promise.resolve({ repositoryId }) }) as Parameters<
      typeof PUT_PROJECT
    >[1];
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`https://app.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, first, context, request };
}

beforeEach(() => {
  session.requireUser.mockResolvedValue(USER);
});

afterEach(async () => {
  await closeDatabase();
});

describe("the global review settings route", () => {
  it("saves the defaults and reads them back", async () => {
    const { request } = await startRoutes();

    const put = await PUT_GLOBAL(
      request("PUT", "/api/review-settings", { settings: { maxFindings: 7 } }),
    );
    const get = await GET_GLOBAL(request("GET", "/api/review-settings"));

    expect(put.status).toBe(200);
    expect(await get.json()).toMatchObject({
      overrides: { maxFindings: 7 },
      updatedBy: "octocat",
    });
  });

  it("asks for the user before it does anything", async () => {
    const { request, db } = await startRoutes();
    session.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      PUT_GLOBAL(request("PUT", "/api/review-settings", { settings: {} })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(await db.selectFrom("app_settings").selectAll().execute()).toEqual(
      [],
    );
  });
});

describe("the project review settings route", () => {
  it("saves, reads and resets the overrides of the project in the URL", async () => {
    const { request, context, first, db } = await startRoutes();
    const path = `/api/repositories/${first.id}/project/settings`;

    const put = await PUT_PROJECT(
      request("PUT", path, { settings: { maxFindings: 2 } }),
      context(first.id),
    );
    const get = await GET_PROJECT(request("GET", path), context(first.id));
    const reset = await DELETE(request("DELETE", path), context(first.id));

    expect(put.status).toBe(200);
    expect(await get.json()).toMatchObject({ overrides: { maxFindings: 2 } });
    expect(await reset.json()).toMatchObject({ overrides: {} });
    expect(
      (await db.selectFrom("projects").selectAll().execute())[0]?.settings,
    ).toBe("{}");
  });

  it("answers 404 for a repository that has no project", async () => {
    const { request, context } = await startRoutes();

    const response = await PUT_PROJECT(
      request("PUT", "/api/repositories/nope/project/settings", {
        settings: {},
      }),
      context("nope"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
    });
  });
});
