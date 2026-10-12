// SPDX-License-Identifier: Apache-2.0

// Pins down the real route files of the review settings with the wiring the running server uses: the
// dynamic segments, the database opened at start, the service on top of it and the workspace access. Only
// the session lookup and `connection()` are replaced (they need Next.js's request scope). The behavior of
// the handlers is in src/review-settings/http.integration.test.ts and the proxy in front is in
// review-settings-route.integration.test.ts; this file proves the pieces are connected, that the defaults
// of a workspace are for Admins and Owners and the settings of a project for every member, and that the
// workspace is the one in the address.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
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
} from "../../src/app/api/w/[workspace]/repositories/[repositoryId]/project/settings/route.ts";
import {
  GET as GET_GLOBAL,
  PUT as PUT_GLOBAL,
} from "../../src/app/api/w/[workspace]/review-settings/route.ts";
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

async function startRoutes() {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const { first } = await seedRepositories(db);
  const workspaceId = await defaultWorkspaceId(db);
  await createProjectsRepository(db, workspaceId).activate(first.id);
  const signIn = async (role: "owner" | "admin" | "member", id = `${role}-1`) =>
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, {
        id,
        workspaceId,
        role,
        githubLogin: "octocat",
      }),
    );
  await signIn("admin");
  const context = (repositoryId: string, workspace = "default") =>
    ({ params: Promise.resolve({ workspace, repositoryId }) }) as Parameters<
      typeof PUT_PROJECT
    >[1];
  const globalContext = (workspace = "default") =>
    ({ params: Promise.resolve({ workspace }) }) as Parameters<
      typeof PUT_GLOBAL
    >[1];
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`https://app.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, first, context, globalContext, request, signIn };
}

afterEach(async () => {
  await closeDatabase();
});

describe("the global review settings route", () => {
  it("saves the defaults and reads them back", async () => {
    const { request, globalContext } = await startRoutes();
    const path = "/api/w/default/review-settings";

    const put = await PUT_GLOBAL(
      request("PUT", path, { settings: { maxFindings: 7 } }),
      globalContext(),
    );
    const get = await GET_GLOBAL(request("GET", path), globalContext());

    expect(put.status).toBe(200);
    expect(await get.json()).toMatchObject({
      overrides: { maxFindings: 7 },
      updatedBy: "octocat",
    });
  });

  // #101-WM-08
  it("lets a Member read the defaults and refuses them to change them", async () => {
    const { request, globalContext, signIn, db } = await startRoutes();
    await signIn("member");
    const path = "/api/w/default/review-settings";

    const get = await GET_GLOBAL(request("GET", path), globalContext());
    const put = await PUT_GLOBAL(
      request("PUT", path, { settings: { maxFindings: 7 } }),
      globalContext(),
    );

    expect(get.status).toBe(200);
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: "forbidden" });
    expect(await db.selectFrom("app_settings").selectAll().execute()).toEqual(
      [],
    );
  });

  // #101-WM-06, #101-WM-07
  it("answers a workspace the person does not belong to like one that does not exist", async () => {
    const { request, globalContext, db } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const workspace of ["default", "nothing"]) {
      const path = `/api/w/${workspace}/review-settings`;
      for (const response of [
        await GET_GLOBAL(request("GET", path), globalContext(workspace)),
        await PUT_GLOBAL(
          request("PUT", path, { settings: {} }),
          globalContext(workspace),
        ),
      ]) {
        expect(response.status, workspace).toBe(404);
        expect(await response.json(), workspace).toEqual({
          error: "not_found",
        });
      }
    }
    expect(await db.selectFrom("app_settings").selectAll().execute()).toEqual(
      [],
    );
  });

  it("asks for the session before it does anything", async () => {
    const { request, db, globalContext } = await startRoutes();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const response = await PUT_GLOBAL(
      request("PUT", "/api/w/default/review-settings", { settings: {} }),
      globalContext(),
    );

    expect(response.status).toBe(401);
    expect(await db.selectFrom("app_settings").selectAll().execute()).toEqual(
      [],
    );
  });
});

describe("the project review settings route", () => {
  it("saves, reads and resets the overrides of the project in the URL", async () => {
    const { request, context, first, db } = await startRoutes();
    const path = `/api/w/default/repositories/${first.id}/project/settings`;

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

  // #101-WM-08
  it("lets a Member change the settings of a project", async () => {
    const { request, context, first, signIn } = await startRoutes();
    await signIn("member");

    const put = await PUT_PROJECT(
      request(
        "PUT",
        `/api/w/default/repositories/${first.id}/project/settings`,
        { settings: { maxFindings: 3 } },
      ),
      context(first.id),
    );

    expect(put.status).toBe(200);
  });

  // #101-WM-07
  it("answers 404 for the project of a workspace the person does not belong to, and changes nothing", async () => {
    const { request, context, first, db } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );
    const before = await db.selectFrom("projects").selectAll().execute();

    const responses = [
      await PUT_PROJECT(
        request(
          "PUT",
          `/api/w/default/repositories/${first.id}/project/settings`,
          { settings: { maxFindings: 3 } },
        ),
        context(first.id),
      ),
      await GET_PROJECT(
        request(
          "GET",
          `/api/w/default/repositories/${first.id}/project/settings`,
        ),
        context(first.id),
      ),
      await DELETE(
        request(
          "DELETE",
          `/api/w/default/repositories/${first.id}/project/settings`,
        ),
        context(first.id),
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(await db.selectFrom("projects").selectAll().execute()).toEqual(
      before,
    );
  });

  it("answers 404 for a repository that has no project", async () => {
    const { request, context } = await startRoutes();

    const response = await PUT_PROJECT(
      request("PUT", "/api/w/default/repositories/nope/project/settings", {
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
