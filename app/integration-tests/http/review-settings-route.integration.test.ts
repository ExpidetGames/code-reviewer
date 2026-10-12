// SPDX-License-Identifier: Apache-2.0

// Pins down who may change the review settings: the access proxy (real Better Auth, real database)
// in front of the handlers of `PUT /api/review-settings` and of the project settings routes. A request
// without a session gets 401, one from a signed in user who is no longer on the allow list gets 403,
// and in both cases nothing is stored. A user on the list can change the global defaults and the
// settings of a project (there is no admin role in the MVP).
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createAccessProxy } from "../../src/auth/access-proxy.ts";
import { lookupSession } from "../../src/auth/session-user.ts";
import { createReviewSettingsRouteHandlers } from "../../src/review-settings/http.ts";
import { setupReviewSettings } from "../../src/test-support/review-settings-harness.ts";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../../src/test-support/auth-harness.ts";
import type { AccessGates } from "../../src/auth/access-gates.ts";
import {
  noWorkspaceGates,
  openGates,
} from "../../src/test-support/open-gates.ts";

type Harness = Awaited<ReturnType<typeof createAuthHarness>>;

async function startApp() {
  const harness = await createAuthHarness();
  const settings = await setupReviewSettings(harness.db);
  await settings.projects.activate(settings.first.id);

  const targets = {
    global: { path: "/api/review-settings", methods: ["PUT"] },
    project: {
      path: `/api/repositories/${settings.first.id}/project/settings`,
      methods: ["PUT", "DELETE"],
    },
  } as const;

  /** What the server does with a request: the proxy first, the handler only if the proxy lets it by. */
  function through(auth: Harness = harness, gates: AccessGates = openGates) {
    const proxy = createAccessProxy({
      getAuth: () => auth.auth,
      getGates: () => gates,
    });
    return async function send(
      target: "global" | "project",
      method: "GET" | "PUT" | "DELETE",
      cookies?: CookieJar,
    ): Promise<Response> {
      const headers = new Headers({ "content-type": "application/json" });
      if (cookies && cookies.size > 0)
        headers.set("cookie", cookieHeader(cookies));
      const url = `${TEST_BASE_URL}${targets[target].path}`;
      const init =
        method === "PUT"
          ? {
              method,
              headers,
              body: JSON.stringify({ settings: { maxFindings: 9 } }),
            }
          : { method, headers };
      const guard = await proxy(new NextRequest(url, init));
      if (guard.headers.get("x-middleware-next") !== "1") return guard;
      const handlers = createReviewSettingsRouteHandlers({
        // The same lookup `requireUser()` makes, without Next.js's request scope.
        requireUser: async () => {
          const lookup = await lookupSession(auth.auth, headers, gates);
          if (lookup.kind !== "user") throw new Error("NEXT_REDIRECT");
          return lookup.user;
        },
        service: settings.service,
      });
      const request = new Request(url, init);
      if (target === "global")
        return method === "GET"
          ? handlers.getGlobal(request)
          : handlers.putGlobal(request);
      if (method === "GET")
        return handlers.getProject(request, settings.first.id);
      if (method === "PUT")
        return handlers.putProject(request, settings.first.id);
      return handlers.deleteProject(request, settings.first.id);
    };
  }

  const stored = async () => ({
    global: await settings.appSettingRows(),
    project: (await settings.projects.get(settings.first.id))?.settings,
  });
  return { harness, settings, through, stored };
}

const CHANGES = [
  ["global", "PUT"],
  ["project", "PUT"],
  ["project", "DELETE"],
] as const;

describe("a request without a session", () => {
  // CR-25-T12
  it.each(CHANGES)(
    "is answered with 401 when it tries %s %s, and nothing is stored",
    async (target, method) => {
      const app = await startApp();
      const before = await app.stored();

      const response = await app.through()(target, method);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      expect(await app.stored()).toEqual(before);
    },
  );

  // CR-25-T12
  it.each(["global", "project"] as const)(
    "is answered with 401 when it only reads the %s settings",
    async (target) => {
      const app = await startApp();

      const response = await app.through()(target, "GET");

      expect(response.status).toBe(401);
    },
  );
});

describe("a signed in user who belongs to no workspace", () => {
  // CR-25-T12
  it.each(CHANGES)(
    "is answered with 403 when trying %s %s, and nothing is stored",
    async (target, method) => {
      const app = await startApp();
      const { cookies } = await app.harness.signIn();
      const before = await app.stored();

      const response = await app.through(app.harness, noWorkspaceGates)(
        target,
        method,
        cookies,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "no_workspace_access" });
      expect(await app.stored()).toEqual(before);
    },
  );
});

describe("a signed in user on the allow list", () => {
  // CR-25-T11, CR-25-T12
  it("changes the global defaults and the settings of a project, and resets the project", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    const send = app.through();

    const global = await send("global", "PUT", cookies);
    const project = await send("project", "PUT", cookies);

    expect(global.status).toBe(200);
    expect(project.status).toBe(200);
    expect((await app.stored()).global).toMatchObject([
      { key: "review_defaults", updated_by: expect.any(String) },
    ]);
    expect((await app.stored()).project).toEqual({ maxFindings: 9 });

    const reset = await send("project", "DELETE", cookies);

    expect(reset.status).toBe(200);
    expect((await app.stored()).project).toEqual({});
  });
});
