// SPDX-License-Identifier: Apache-2.0

// Pins down who may read the runs and what they get: the access proxy (real Better Auth, real
// database) in front of the handlers of `GET /api/runs` and `GET /api/runs/:id`. A request without a
// session gets 401, one from a signed in user who is no longer on the allow list gets 403, and in
// both cases nothing of any run is in the answer. A user on the list reads the runs, and the answer
// holds no token, key or lease detail.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createAccessProxy } from "../../src/auth/access-proxy.ts";
import { lookupSession } from "../../src/auth/session-user.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createRunsRepository } from "../../src/db/repositories/runs-repository.ts";
import { createTestQueue } from "../../src/test-support/jobs.ts";
import { createRunsRouteHandlers } from "../../src/runs/http.ts";
import { createRunsService } from "../../src/runs/runs-service.ts";
import {
  TEST_BASE_URL,
  cookieHeader,
  createAuthHarness,
  type CookieJar,
} from "../../src/test-support/auth-harness.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";
import type { AccessGates } from "../../src/auth/access-gates.ts";
import {
  noWorkspaceGates,
  openGates,
} from "../../src/test-support/open-gates.ts";

type Harness = Awaited<ReturnType<typeof createAuthHarness>>;

const SECRET_LOG_MARKER = "a-log-line-of-this-run";

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

  // One finished run, made through the queue the way the runner API makes it.
  const queue = createTestQueue(
    harness.db,
    await defaultWorkspaceId(harness.db),
  );
  const created = await queue.enqueue({
    repositoryId: repository.id,
    prNumber: 7,
    prUrl: "https://github.com/acme/widgets/pull/7",
    headSha: "a".repeat(40),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: "delivery-xyz",
  });
  const claim = await queue.claimNext("runner-secret-name");
  if (created.status !== "created" || claim === null)
    throw new Error("seeding failed");
  await queue.complete(created.job.id, claim.leaseToken, {
    ok: true,
    result: {
      ok: true,
      commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1",
      logTail: SECRET_LOG_MARKER,
    },
  });

  const service = createRunsService({
    runs: createRunsRepository(
      harness.db,
      await defaultWorkspaceId(harness.db),
    ),
  });

  /** What the server does with a request: the proxy first, the handler only if the proxy lets it by. */
  function through(
    settings: Harness = harness,
    gates: AccessGates = openGates,
  ) {
    const proxy = createAccessProxy({
      getAuth: () => settings.auth,
      getGates: () => gates,
    });
    return async function send(
      path: string,
      cookies?: CookieJar,
    ): Promise<Response> {
      const headers = new Headers();
      if (cookies && cookies.size > 0)
        headers.set("cookie", cookieHeader(cookies));
      const url = `${TEST_BASE_URL}${path}`;
      const guard = await proxy(new NextRequest(url, { headers }));
      if (guard.headers.get("x-middleware-next") !== "1") return guard;
      const handlers = createRunsRouteHandlers({
        // The same lookup `requireUser()` makes, without Next.js's request scope.
        requireUser: async () => {
          const lookup = await lookupSession(settings.auth, headers, gates);
          if (lookup.kind !== "user") throw new Error("NEXT_REDIRECT");
          return lookup.user;
        },
        service,
      });
      const request = new Request(url, { headers });
      if (path.startsWith("/api/runs/"))
        return handlers.detail(request, path.slice("/api/runs/".length));
      return handlers.list(request);
    };
  }

  return { harness, repository, job: created.job, through };
}

describe("a request without a session", () => {
  // CR-35-T16
  it("is answered with 401 for the list and for one run, and nothing of a run is in the answer", async () => {
    const app = await startApp();
    const send = app.through();

    for (const path of ["/api/runs", `/api/runs/${app.job.id}`]) {
      const response = await send(path);
      const text = await response.text();

      expect(response.status).toBe(401);
      expect(text).toBe(JSON.stringify({ error: "UNAUTHENTICATED" }));
      expect(text).not.toContain(app.job.id);
      expect(text).not.toContain("acme/widgets");
    }
  });
});

describe("a signed in user who belongs to no workspace", () => {
  // CR-35-T16
  it("is answered with 403 for the list and for one run, and nothing of a run is in the answer", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();

    for (const path of ["/api/runs", `/api/runs/${app.job.id}`]) {
      const response = await app.through(app.harness, noWorkspaceGates)(
        path,
        cookies,
      );
      const text = await response.text();

      expect(response.status).toBe(403);
      expect(text).not.toContain(app.job.id);
      expect(text).not.toContain("acme/widgets");
    }
  });
});

describe("a signed in user on the allow list", () => {
  // CR-35-T01
  it("reads the list, newest first, with no caching", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();

    const response = await app.through()("/api/runs", cookies);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      runs: { id: string; project: string; status: string }[];
    };
    expect(body.runs.map((run) => [run.id, run.project, run.status])).toEqual([
      [app.job.id, "acme/widgets", "succeeded"],
    ]);
  });

  // CR-35-T02
  it("filters by project and status in the address", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    const send = app.through();
    const runs = async (query: string) =>
      (
        (await (await send(`/api/runs?${query}`, cookies)).json()) as {
          runs: unknown[];
        }
      ).runs;

    expect(
      await runs(`repository=${app.repository.id}&status=succeeded`),
    ).toHaveLength(1);
    expect(
      await runs(`repository=${app.repository.id}&status=failed`),
    ).toHaveLength(0);
    expect(await runs("repository=another-repository")).toHaveLength(0);
  });

  it("refuses a status that does not exist with 400", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();

    const response = await app.through()("/api/runs?status=exploded", cookies);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "RUNS_FILTER_INVALID" });
  });

  // CR-35-T04
  it("reads one run with its comment link and log", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();

    const response = await app.through()(`/api/runs/${app.job.id}`, cookies);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: {
        id: app.job.id,
        commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1",
        log: { text: SECRET_LOG_MARKER },
      },
    });
  });

  // CR-35-T05
  it("is answered with 404 and no details for an id nobody has or that is not an id", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();

    for (const id of [
      "00000000-0000-4000-8000-000000000000",
      "7",
      "..%2F..%2Fetc%2Fpasswd",
    ]) {
      const response = await app.through()(`/api/runs/${id}`, cookies);
      const text = await response.text();

      expect(response.status).toBe(404);
      expect(text).toBe(JSON.stringify({ error: "RUN_NOT_FOUND" }));
    }
  });

  // CR-35-T15
  it("receives no token, key, runner name or lease detail in the list or the detail", async () => {
    const app = await startApp();
    const { cookies } = await app.harness.signIn();
    const leaseToken = (
      await app.harness.db
        .selectFrom("jobs")
        .select("lease_token")
        .executeTakeFirstOrThrow()
    ).lease_token;
    expect(leaseToken).not.toBeNull();

    for (const path of ["/api/runs", `/api/runs/${app.job.id}`]) {
      const text = await (await app.through()(path, cookies)).text();

      expect(text).not.toContain(leaseToken ?? "no token");
      expect(text).not.toContain("runner-secret-name");
      expect(text).not.toContain("delivery-xyz");
      expect(text).not.toMatch(
        /lease|heartbeat|runnerId|deliveryId|token|apiKey/i,
      );
    }
  });
});
