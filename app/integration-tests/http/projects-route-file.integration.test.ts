// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route file `PUT /api/w/:workspace/repositories/:repositoryId/project` with the wiring the
// running server uses: the dynamic segments, the database opened at start, the project service and the
// workspace access. Only the session lookup and `connection()` are replaced (they need Next.js's request
// scope). The behavior of the handler is in src/projects/http.integration.test.ts and the proxy in front is
// in projects-route.integration.test.ts; this file proves the pieces are connected, and that switching a
// project on or off is for Admins and Owners and for the workspace in the address only.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import { PUT } from "../../src/app/api/w/[workspace]/repositories/[repositoryId]/project/route.ts";
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

async function startRoute() {
  await openRouteTestDatabase();
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
      externalId: "1",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      workspaceId: await defaultWorkspaceId(db),
      role: "admin",
    }),
  );

  function put(
    repositoryId: string,
    body: unknown,
    workspace = "default",
  ): Promise<Response> {
    return PUT(
      new Request(
        `https://app.test/api/w/${workspace}/repositories/${repositoryId}/project`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ workspace, repositoryId }) } as Parameters<
        typeof PUT
      >[1],
    );
  }
  return {
    db,
    repository,
    put,
    projectRows: () => db.selectFrom("projects").selectAll().execute(),
  };
}

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

  // #101-WM-08
  it("refuses a Member and changes nothing: switching projects on and off is for Admins and Owners", async () => {
    const { put, repository, projectRows, db } = await startRoute();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, {
        id: "plain-member",
        workspaceId: await defaultWorkspaceId(db),
        role: "member",
      }),
    );

    const response = await put(repository.id, { active: true });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await projectRows()).toEqual([]);
  });

  // #101-WM-06, #101-WM-07
  it("answers a person who does not belong to the workspace like for a workspace that does not exist, and changes nothing", async () => {
    const { put, repository, projectRows, db } = await startRoute();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const workspace of ["default", "no-such-workspace"]) {
      const response = await put(repository.id, { active: true }, workspace);
      expect(response.status, workspace).toBe(404);
      expect(await response.json(), workspace).toEqual({ error: "not_found" });
    }
    expect(await projectRows()).toEqual([]);
  });

  // CR-24-T10, CR-24-T11
  it("asks for the session before it reads anything, and answers a visitor with 401", async () => {
    const { put, repository, projectRows } = await startRoute();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const response = await put(repository.id, { active: true });

    expect(response.status).toBe(401);
    expect(await projectRows()).toEqual([]);
  });

  it("exports only the PUT method", async () => {
    const route =
      await import("../../src/app/api/w/[workspace]/repositories/[repositoryId]/project/route.ts");

    expect(Object.keys(route).sort()).toEqual(["PUT"]);
  });
});
