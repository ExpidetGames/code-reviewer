// Pins down who may switch a project on or off: the access proxy (real Better Auth, real database)
// in front of the handler of `PUT /api/repositories/:id/project`. A request without a session gets
// 401, one from a signed in user who is no longer on the allow list gets 403, and in both cases the
// project state stays as it was. A user on the list can activate and deactivate.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createAccessProxy } from "../../src/auth/access-proxy.ts";
import { lookupSession } from "../../src/auth/session-user.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createProjectRouteHandler } from "../../src/projects/http.ts";
import { createProjectService } from "../../src/projects/service.ts";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../../src/test-support/auth-harness.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

type Harness = Awaited<ReturnType<typeof createAuthHarness>>;

async function startApp() {
  const harness = await createAuthHarness();
  const integration = await createIntegrationsRepository(
    harness.db,
    await defaultWorkspaceId(harness.db),
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(
    harness.db,
    await defaultWorkspaceId(harness.db),
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
  const projects = createProjectsRepository(
    harness.db,
    await defaultWorkspaceId(harness.db),
  );
  const service = createProjectService({ projects });

  /**
   * What the server does with a request: the proxy first, the handler only if the proxy lets it by.
   * `settings` are the access settings in force (a restarted harness has other ones).
   */
  function through(settings: Harness = harness) {
    const proxy = createAccessProxy({
      getAuth: () => settings.auth,
      getPolicy: () => settings.policy,
    });
    return async function send(
      active: boolean,
      cookies?: CookieJar,
    ): Promise<Response> {
      const headers = new Headers({ "content-type": "application/json" });
      if (cookies && cookies.size > 0)
        headers.set("cookie", cookieHeader(cookies));
      const url = `${TEST_BASE_URL}/api/repositories/${repository.id}/project`;
      const init = { method: "PUT", headers, body: JSON.stringify({ active }) };
      const guard = await proxy(new NextRequest(url, init));
      if (guard.headers.get("x-middleware-next") !== "1") return guard;
      const handler = createProjectRouteHandler({
        // The same lookup `requireUser()` makes, without Next.js's request scope.
        requireUser: async () => {
          const lookup = await lookupSession(
            settings.auth,
            headers,
            settings.policy,
          );
          if (lookup.kind !== "user") throw new Error("NEXT_REDIRECT");
          return lookup.user;
        },
        service,
      });
      return handler(new Request(url, init), repository.id);
    };
  }

  return {
    harness,
    repository,
    service,
    through,
    projectRows: () => harness.db.selectFrom("projects").selectAll().execute(),
  };
}

describe("a request without a session", () => {
  // CR-24-T10
  it("is answered with 401 when it tries to activate, and creates no project", async () => {
    const app = await startApp();

    const response = await app.through()(true);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(await app.projectRows()).toEqual([]);
  });

  // CR-24-T10
  it("is answered with 401 when it tries to deactivate, and the project stays active", async () => {
    const app = await startApp();
    await app.service.activateProject(app.repository.id);
    const before = await app.projectRows();

    const response = await app.through()(false);

    expect(response.status).toBe(401);
    expect(await app.projectRows()).toEqual(before);
    expect(before).toMatchObject([{ active: 1 }]);
  });
});

describe("a signed in user who is not on the allow list", () => {
  // CR-24-T11
  it("is answered with 403 when trying to activate, and creates no project", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    const removed = app.harness.restart({ allowedLogins: ["somebody-else"] });

    const response = await app.through(removed)(true, cookies);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "ACCESS_DENIED",
      reason: "not_allowed",
    });
    expect(await app.projectRows()).toEqual([]);
  });

  // CR-24-T11
  it("is answered with 403 when trying to deactivate, and the project stays active", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    await app.service.activateProject(app.repository.id);
    const before = await app.projectRows();
    const removed = app.harness.restart({ allowedLogins: ["somebody-else"] });

    const response = await app.through(removed)(false, cookies);

    expect(response.status).toBe(403);
    expect(await app.projectRows()).toEqual(before);
  });
});

describe("a signed in user on the allow list", () => {
  // CR-24-T01, CR-24-T02
  it("activates and deactivates a repository", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    const send = app.through();

    const on = await send(true, cookies);
    expect(on.status).toBe(200);
    expect(await app.projectRows()).toMatchObject([{ active: 1 }]);

    const off = await send(false, cookies);
    expect(off.status).toBe(200);
    expect(await app.projectRows()).toMatchObject([{ active: 0 }]);
  });
});
