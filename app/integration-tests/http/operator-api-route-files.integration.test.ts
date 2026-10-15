// SPDX-License-Identifier: Apache-2.0

// The real route files of the operator API with the wiring the running server uses: the token from the
// environment, the database opened at start. Without a usable token every method of every route ends in Next.js's
// `notFound()` before the database is touched, so an instance that never set the variable has no extra surface; with
// one, a call goes through the real repositories. The details are in operator-api.integration.test.ts.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { markInstanceSetUp } from "../../src/test-support/workspaces.ts";

// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const TOKEN = "route-file-operator-token-5e2a-91c4d7b3f860";
const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

type Route = Record<(typeof METHODS)[number], (...args: never[]) => unknown>;

async function loadRoutes() {
  vi.resetModules();
  const list =
    (await import("../../src/app/api/operator/v1/workspaces/route.ts")) as unknown as Route;
  const entitlements =
    (await import("../../src/app/api/operator/v1/workspaces/[id]/entitlements/route.ts")) as unknown as Route;
  const defaults =
    (await import("../../src/app/api/operator/v1/entitlements/default/route.ts")) as unknown as Route;
  const rest =
    (await import("../../src/app/api/operator/v1/[...path]/route.ts")) as unknown as Route;
  const usage =
    (await import("../../src/app/api/operator/v1/usage/route.ts")) as unknown as Route;
  const workspaceUsage =
    (await import("../../src/app/api/operator/v1/workspaces/[id]/usage/route.ts")) as unknown as Route;
  const usageSummary =
    (await import("../../src/app/api/operator/v1/workspaces/[id]/usage/summary/route.ts")) as unknown as Route;
  return {
    list,
    entitlements,
    defaults,
    rest,
    usage,
    workspaceUsage,
    usageSummary,
  };
}

function request(method: string, token?: string, body?: unknown): Request {
  return new Request("https://app.test/api/operator/v1/x", {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined || method === "GET"
      ? {}
      : { body: JSON.stringify(body) }),
  });
}

async function startDatabase() {
  const directory = await createTestDirectory();
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(directory, "app.db") },
  });
  return markInstanceSetUp(getDatabase());
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the operator API route files while the API is off", () => {
  // #275-T01
  it.each([
    ["not set", undefined],
    ["blank", "   "],
    ["too short", "short-token"],
    ["with white space inside", `${"a".repeat(20)} ${"b".repeat(20)}`],
  ])(
    "end every method of every route in notFound() when the token is %s, without opening the database",
    async (_name, value) => {
      if (value !== undefined) vi.stubEnv("OPERATOR_API_TOKEN", value);
      else vi.stubEnv("OPERATOR_API_TOKEN", "");
      // No database was opened: a route that touched it would fail with another error.
      const routes = await loadRoutes();
      const context = { params: Promise.resolve({ id: "any" }) };

      for (const route of Object.values(routes))
        for (const method of METHODS) {
          const call = Promise.resolve().then(() =>
            (route[method] as (...args: unknown[]) => unknown)(
              request(method, value),
              context,
            ),
          );
          await expect(call).rejects.toMatchObject({
            digest: "NEXT_HTTP_ERROR_FALLBACK;404",
          });
        }
    },
  );

  // #275-T02
  it("stays off for a token equal to RUNNER_TOKEN or APP_SECRET", async () => {
    vi.stubEnv("OPERATOR_API_TOKEN", TOKEN);
    vi.stubEnv("RUNNER_TOKEN", TOKEN);
    const { list } = await loadRoutes();

    await expect(
      Promise.resolve().then(() => list.GET(request("GET", TOKEN) as never)),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });

    vi.stubEnv("RUNNER_TOKEN", "");
    vi.stubEnv("APP_SECRET", TOKEN);
    const again = await loadRoutes();
    await expect(
      Promise.resolve().then(() =>
        again.list.GET(request("GET", TOKEN) as never),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});

describe("the operator API route files while the API is on", () => {
  // #275-T05
  it("serve the workspace list and an entitlements round trip through the real wiring", async () => {
    vi.stubEnv("OPERATOR_API_TOKEN", TOKEN);
    const workspaceId = await startDatabase();
    const routes = await loadRoutes();
    const context = { params: Promise.resolve({ id: workspaceId }) };
    const body = {
      planLabel: "team",
      keyMode: "own",
      limits: {
        diffRunsPerPeriod: 10,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
      },
      suspended: false,
      suspensionCode: null,
    };
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const list = (await routes.list.GET(
      request("GET", TOKEN) as never,
    )) as Response;
    const put = (await routes.entitlements.PUT(
      request("PUT", TOKEN, body) as never,
      context as never,
    )) as Response;
    const get = (await routes.entitlements.GET(
      request("GET", TOKEN) as never,
      context as never,
    )) as Response;
    const wrong = (await routes.entitlements.GET(
      request("GET", "wrong") as never,
      context as never,
    )) as Response;
    const unknown = (await routes.rest.GET(
      request("GET", TOKEN) as never,
    )) as Response;

    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      workspaces: [{ id: workspaceId }],
    });
    expect(put.status).toBe(200);
    expect(await get.json()).toMatchObject({
      stored: { planLabel: "team" },
      effective: { kind: "limited", source: "workspace" },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ version: 1, error: "not_found" });
  });

  // #278-T07
  it("serve the usage routes through the real wiring, and refuse a wrong token", async () => {
    vi.stubEnv("OPERATOR_API_TOKEN", TOKEN);
    const workspaceId = await startDatabase();
    const routes = await loadRoutes();
    const context = { params: Promise.resolve({ id: workspaceId }) };
    const from = "2026-10-01T00:00:00.000Z";
    const to = "2026-11-01T00:00:00.000Z";
    const withQuery = (query: string, token: string) =>
      new Request(`https://app.test/api/operator/v1/x?${query}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });

    const feed = (await routes.usage.GET(
      request("GET", TOKEN) as never,
    )) as Response;
    const mine = (await routes.workspaceUsage.GET(
      request("GET", TOKEN) as never,
      context as never,
    )) as Response;
    const summary = (await routes.usageSummary.GET(
      withQuery(`from=${from}&to=${to}`, TOKEN) as never,
      context as never,
    )) as Response;
    const wrong = (await routes.usage.GET(
      request("GET", "wrong") as never,
    )) as Response;

    expect(feed.status).toBe(200);
    expect(await feed.json()).toEqual({
      version: 1,
      items: [],
      nextCursor: null,
    });
    expect(mine.status).toBe(200);
    expect(await summary.json()).toMatchObject({ workspaceId, groups: [] });
    expect(wrong.status).toBe(401);
  });

  // #275-T03
  it("answers 500 in the usual form when the database was not opened, without a token in the log", async () => {
    vi.stubEnv("OPERATOR_API_TOKEN", TOKEN);
    const routes = await loadRoutes();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = (await routes.list.GET(
      request("GET", TOKEN) as never,
    )) as Response;

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      error: "internal_error",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
  });
});
