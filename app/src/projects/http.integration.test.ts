// Pins down the handler behind `PUT /api/repositories/:id/project`: it asks for the user first, checks
// the request, calls the service and answers with a stable error code. The user check is injected so
// this test needs no session; the proxy in front of the real route is tested in
// integration-tests/http/projects-route.integration.test.ts.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { SessionUser } from "../auth/access-policy.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createProjectRouteHandler } from "./http.ts";
import { createProjectService } from "./service.ts";

const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;

async function setup(
  requireUser: () => Promise<SessionUser> = async () => USER,
) {
  const { db } = await createTestDatabase();
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
  const service = createProjectService({
    projects: createProjectsRepository(db),
  });
  const handler = createProjectRouteHandler({ requireUser, service });
  const put = (
    repositoryId: string,
    body: unknown,
    headers: Record<string, string> = {
      "content-type": "application/json",
    },
  ) =>
    handler(
      new Request(`https://app.test/api/repositories/${repositoryId}/project`, {
        method: "PUT",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      repositoryId,
    );
  return {
    db,
    repository,
    integration,
    repositories,
    service,
    put,
    projectRows: () => db.selectFrom("projects").selectAll().execute(),
  };
}

describe("switching a project on and off over HTTP", () => {
  // CR-24-T01
  it("activates a repository and answers with the project", async () => {
    const { put, repository, projectRows } = await setup();

    const response = await put(repository.id, { active: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      repositoryId: repository.id,
      projectId: (await projectRows())[0]?.id,
      active: true,
      changed: true,
    });
  });

  // CR-24-T07
  it("answers a repeated activation without an error and says nothing changed", async () => {
    const { put, repository, projectRows } = await setup();
    await put(repository.id, { active: true });

    const response = await put(repository.id, { active: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      active: true,
      changed: false,
    });
    expect(await projectRows()).toHaveLength(1);
  });

  // CR-24-T02
  it("deactivates a project and keeps its row", async () => {
    const { put, repository, projectRows } = await setup();
    await put(repository.id, { active: true });

    const response = await put(repository.id, { active: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      active: false,
      changed: true,
    });
    expect(await projectRows()).toMatchObject([{ active: 0 }]);
  });

  it("treats deactivating a repository without a project as already inactive", async () => {
    const { put, repository, projectRows } = await setup();

    const response = await put(repository.id, { active: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositoryId: repository.id,
      projectId: null,
      active: false,
      changed: false,
    });
    expect(await projectRows()).toEqual([]);
  });

  // CR-24-T08
  it("refuses a repository that is no longer on the platform with PROJECT_REPOSITORY_UNAVAILABLE", async () => {
    const { put, repository, repositories, integration, projectRows } =
      await setup();
    await repositories.reconcile(integration.id, []);

    const response = await put(repository.id, { active: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "PROJECT_REPOSITORY_UNAVAILABLE",
    });
    expect(await projectRows()).toEqual([]);
  });

  // CR-24-T09
  it("answers 404 PROJECT_REPOSITORY_NOT_FOUND for an unknown repository and creates nothing", async () => {
    const { put, projectRows } = await setup();

    for (const active of [true, false]) {
      const response = await put("no-such-repository", { active });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "PROJECT_REPOSITORY_NOT_FOUND",
      });
    }
    expect(await projectRows()).toEqual([]);
  });
});

describe("a request that is not usable", () => {
  it.each([
    ["a body that is not JSON", "not json"],
    ["a body that is not an object", "true"],
    ["an object without active", "{}"],
    ["an active that is not a boolean", '{"active":"yes"}'],
    ["an active of 1", '{"active":1}'],
    ["an empty body", ""],
  ])(
    "is answered with 400 PROJECT_REQUEST_INVALID for %s",
    async (_name, body) => {
      const { put, repository, projectRows } = await setup();

      const response = await put(repository.id, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "PROJECT_REQUEST_INVALID",
      });
      expect(await projectRows()).toEqual([]);
    },
  );

  it("is refused without a JSON content type, so a cross-site form cannot switch a project", async () => {
    const { put, repository, projectRows } = await setup();

    for (const headers of [
      { "content-type": "text/plain" },
      { "content-type": "application/x-www-form-urlencoded" },
      {} as Record<string, string>,
    ]) {
      const response = await put(repository.id, '{"active":true}', headers);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "PROJECT_REQUEST_INVALID",
      });
    }
    expect(await projectRows()).toEqual([]);
  });

  it("accepts a JSON content type with a charset", async () => {
    const { put, repository } = await setup();

    const response = await put(
      repository.id,
      { active: true },
      {
        "content-type": "application/json; charset=utf-8",
      },
    );

    expect(response.status).toBe(200);
  });

  it("is refused when the body is larger than a small limit", async () => {
    const { put, repository, projectRows } = await setup();

    const response = await put(
      repository.id,
      JSON.stringify({ active: true, padding: "x".repeat(10_000) }),
    );

    expect(response.status).toBe(400);
    expect(await projectRows()).toEqual([]);
  });
});

describe("the user check", () => {
  // CR-24-T10, CR-24-T11
  it("comes before anything is read or written, and its refusal reaches the caller", async () => {
    const refusal = new Error("NEXT_REDIRECT");
    const { put, repository, projectRows } = await setup(async () => {
      throw refusal;
    });

    await expect(put(repository.id, { active: true })).rejects.toBe(refusal);
    await expect(put(repository.id, { active: false })).rejects.toBe(refusal);
    // Not even an invalid request is looked at before the user is known.
    await expect(put(repository.id, "garbage")).rejects.toBe(refusal);

    expect(await projectRows()).toEqual([]);
  });
});
