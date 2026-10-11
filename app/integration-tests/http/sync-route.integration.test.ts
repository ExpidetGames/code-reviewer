// Pins down who may run the sync by button: the access proxy (real Better Auth, real database) in
// front of the handler of `POST /api/integrations/sync`. A request without a session gets 401, one
// from a signed in user who is no longer on the allow list gets 403, and in both cases GitHub is not
// called and nothing is stored. A user on the list runs the sync and sees the new repository.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createAccessProxy } from "../../src/auth/access-proxy.ts";
import { lookupSession } from "../../src/auth/session-user.ts";
import { createSyncRouteHandler } from "../../src/integrations/sync/http.ts";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../../src/test-support/auth-harness.ts";
import { startSyncHarness } from "../../src/test-support/integration-sync-harness.ts";

type Auth = Awaited<ReturnType<typeof createAuthHarness>>;

async function startApp() {
  const harness = await createAuthHarness();
  // The GitHub the sync reads from is a second fake, so its request log shows only sync calls.
  const github = await startSyncHarness();
  github.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  github.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

  function through(settings: Auth = harness) {
    const proxy = createAccessProxy({
      getAuth: () => settings.auth,
      getPolicy: () => settings.policy,
    });
    return async function send(cookies?: CookieJar): Promise<Response> {
      const headers = new Headers();
      if (cookies && cookies.size > 0)
        headers.set("cookie", cookieHeader(cookies));
      const url = `${TEST_BASE_URL}/api/integrations/sync`;
      const init = { method: "POST", headers };
      const guard = await proxy(new NextRequest(url, init));
      if (guard.headers.get("x-middleware-next") !== "1") return guard;
      const handler = createSyncRouteHandler({
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
        sync: github.sync,
      });
      return handler(new Request(url, init));
    };
  }
  return { harness, github, through };
}

describe("a request without a session", () => {
  // CR-21-T11
  it("is answered with 401, GitHub is not called and nothing is stored", async () => {
    const app = await startApp();

    const response = await app.through()();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(app.github.fake.requests()).toEqual([]);
    expect(await app.github.repositories.list()).toEqual([]);
  });
});

describe("a signed in user who is not on the allow list", () => {
  // CR-21-T12
  it("is answered with 403, GitHub is not called and nothing is stored", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    const removed = app.harness.restart({ allowedLogins: ["somebody-else"] });

    const response = await app.through(removed)(cookies);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "ACCESS_DENIED",
      reason: "not_allowed",
    });
    expect(app.github.fake.requests()).toEqual([]);
    expect(await app.github.repositories.list()).toEqual([]);
  });
});

describe("a signed in user on the allow list", () => {
  // CR-21-T03
  it("runs the sync, the new repository appears and the answer names how many are new", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();

    const response = await app.through()(cookies);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 1, errors: [] });
    expect(
      (await app.github.repositories.list()).map((repo) => repo.fullName),
    ).toEqual(["acme/widgets"]);
  });
});
