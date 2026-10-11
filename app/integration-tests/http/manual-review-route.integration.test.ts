// SPDX-License-Identifier: Apache-2.0

// Pins down who may use the manual start: the access proxy (real Better Auth, real database) in
// front of the handlers of `GET /api/repositories/:id/pull-requests` and
// `POST /api/repositories/:id/reviews`. A request without a session gets 401, one from a signed in
// user who is no longer on the allow list gets 403, and in both cases the service is not asked at
// all, so no job exists and no pull request data is in the answer. A user on the list gets through.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createAccessProxy } from "../../src/auth/access-proxy.ts";
import { lookupSession } from "../../src/auth/session-user.ts";
import { createManualReviewRouteHandlers } from "../../src/manual-reviews/http.ts";
import type { ManualReviewService } from "../../src/manual-reviews/service.ts";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../../src/test-support/auth-harness.ts";
import { openGates } from "../../src/test-support/open-gates.ts";

type Harness = Awaited<ReturnType<typeof createAuthHarness>>;

async function startApp() {
  const harness = await createAuthHarness();
  const calls: string[] = [];
  // Records what the handlers ask for; the real service is tested in src/manual-reviews.
  const service: ManualReviewService = {
    async listOpenPullRequests(repositoryId) {
      calls.push(`list ${repositoryId}`);
      return {
        repositoryId,
        fullName: "acme/widgets",
        allowedCommands: ["review"],
        pullRequests: [],
      };
    },
    async startReview(user, repositoryId) {
      calls.push(`start ${repositoryId} by ${user.githubLogin}`);
      return { runId: "run-1", created: true, prNumber: 7, command: "review" };
    },
  };

  function through(settings: Harness = harness) {
    const proxy = createAccessProxy({
      getAuth: () => settings.auth,
      getPolicy: () => settings.policy,
      getGates: () => openGates,
    });
    return async function send(
      action: "list" | "start",
      cookies?: CookieJar,
    ): Promise<Response> {
      const headers = new Headers({ "content-type": "application/json" });
      if (cookies && cookies.size > 0)
        headers.set("cookie", cookieHeader(cookies));
      const url = `${TEST_BASE_URL}/api/repositories/repo-1/${action === "list" ? "pull-requests" : "reviews"}`;
      const init =
        action === "list"
          ? { method: "GET", headers }
          : {
              method: "POST",
              headers,
              body: JSON.stringify({ prNumber: 7, command: "review" }),
            };
      const guard = await proxy(new NextRequest(url, init));
      if (guard.headers.get("x-middleware-next") !== "1") return guard;
      const handlers = createManualReviewRouteHandlers({
        // The same lookup `requireUser()` makes, without Next.js's request scope.
        requireUser: async () => {
          const lookup = await lookupSession(
            settings.auth,
            headers,
            settings.policy,
            openGates,
          );
          if (lookup.kind !== "user") throw new Error("NEXT_REDIRECT");
          return lookup.user;
        },
        service,
      });
      const request = new Request(url, init);
      return action === "list"
        ? handlers.list(request, "repo-1")
        : handlers.start(request, "repo-1");
    };
  }

  return { harness, calls, through };
}

describe("a request without a session", () => {
  // CR-33-T11
  it.each(["list", "start"] as const)(
    "is answered with 401 when it tries to %s, with no pull request data and no job",
    async (action) => {
      const app = await startApp();

      const response = await app.through()(action);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      expect(app.calls).toEqual([]);
    },
  );
});

describe("a signed in user who is not on the allow list", () => {
  // CR-33-T12
  it.each(["list", "start"] as const)(
    "is answered with 403 when it tries to %s, and no job is created",
    async (action) => {
      const app = await startApp();
      const { cookies } = await app.harness.signIn();
      const removed = app.harness.restart({
        allowedLogins: ["somebody-else"],
      });

      const response = await app.through(removed)(action, cookies);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "ACCESS_DENIED",
        reason: "not_allowed",
      });
      expect(app.calls).toEqual([]);
    },
  );
});

describe("a signed in user on the allow list", () => {
  // CR-33-T04
  it("gets through to the list and to the start, and the start carries their login", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    const send = app.through();

    const list = await send("list", cookies);
    const start = await send("start", cookies);

    expect(list.status).toBe(200);
    expect(start.status).toBe(201);
    expect(app.calls).toHaveLength(2);
    expect(app.calls[1]).toMatch(/^start repo-1 by /);
  });
});
