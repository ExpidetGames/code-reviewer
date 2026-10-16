// SPDX-License-Identifier: Apache-2.0

// POST /api/w/:workspace/plan-handoff through the real route file, with the wiring the running server uses (the
// database opened at start, the workspace access); only the session lookup and `connection()` are replaced, they
// need Next.js's request scope. What is pinned down: no route while no plan page is configured; an Owner or Admin is
// redirected to the configured page with a token that is stored only as a hash; a Member, another workspace's member,
// a cross-site request and too many requests are refused without a token being made; the target of the redirect is
// the setting and nothing of the request; and no log line or answer holds the token.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createPlanHandoffRedeemRepository } from "../../src/db/repositories/plan-handoff-redeem-repository.ts";
import { createWorkspacesRepository } from "../../src/db/repositories/workspaces-repository.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { PLAN_HANDOFF_MAX } from "../../src/plan-handoff/limits.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import type { WorkspaceRole } from "../../src/workspaces/roles.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const PLAN_PAGE = "https://plans.example/manage";
const logged: string[] = [];

type Route =
  typeof import("../../src/app/api/w/[workspace]/plan-handoff/route.ts");

async function start(options: { configured?: boolean } = {}) {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  vi.resetModules();
  const db = getDatabase();
  const workspaces = createWorkspacesRepository(db);
  const alpha = await workspaces.create({
    name: "Alpha",
    slug: "alpha",
    createdBy: null,
  });
  const beta = await workspaces.create({
    name: "Beta",
    slug: "beta",
    createdBy: null,
  });
  if (options.configured !== false)
    await createInstanceSettingsRepository(db).set(
      "plan_management_url",
      PLAN_PAGE,
      null,
    );
  const people: Record<WorkspaceRole, SessionLookup> = {
    owner: await signedInMember(db, {
      id: "owner-alpha",
      workspaceId: alpha.id,
      role: "owner",
    }),
    admin: await signedInMember(db, {
      id: "admin-alpha",
      workspaceId: alpha.id,
      role: "admin",
    }),
    member: await signedInMember(db, {
      id: "member-alpha",
      workspaceId: alpha.id,
      role: "member",
    }),
  };
  const outsider = await signedInMember(db, {
    id: "owner-beta",
    workspaceId: beta.id,
    role: "owner",
  });
  const route =
    (await import("../../src/app/api/w/[workspace]/plan-handoff/route.ts")) as Route;
  const post = (
    headers: Record<string, string> = {},
    slug = "alpha",
    query = "",
  ) =>
    route.POST(
      new Request(`https://app.test/api/w/${slug}/plan-handoff${query}`, {
        method: "POST",
        headers,
      }),
      { params: Promise.resolve({ workspace: slug }) },
    );
  return {
    db,
    alpha,
    beta,
    post,
    as: (role: WorkspaceRole) =>
      session.currentLookup.mockResolvedValue(people[role]),
    asOutsider: () => session.currentLookup.mockResolvedValue(outsider),
    asNobody: () => session.currentLookup.mockResolvedValue({ kind: "none" }),
    tokens: () => db.selectFrom("plan_handoff_tokens").selectAll().execute(),
  };
}

function tokenOf(response: Response): string {
  const location = response.headers.get("location");
  if (location === null) throw new Error("no redirect");
  const token = new URL(location).searchParams.get("handoff");
  if (token === null) throw new Error("no token in the redirect");
  return token;
}

beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("while no plan management page is configured", () => {
  // #284-T01
  it.each(["owner", "admin", "member"] as const)(
    "is a missing path for %s, and no token is made",
    async (role) => {
      const t = await start({ configured: false });
      t.as(role);

      await expect(t.post()).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
      expect(await t.tokens()).toEqual([]);
    },
  );

  // #284-T01
  it("is a missing path for somebody who is not signed in either", async () => {
    const t = await start({ configured: false });
    t.asNobody();

    await expect(t.post()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  // #284-T11
  it("is a missing path when what is stored is not a valid page", async () => {
    const t = await start({ configured: false });
    await createInstanceSettingsRepository(t.db).set(
      "plan_management_url",
      "http://plans.example/manage",
      null,
    );
    t.as("owner");

    await expect(t.post()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });
});

describe("an Owner or an Admin who clicks Manage plan", () => {
  // #284-T02
  it.each(["owner", "admin"] as const)(
    "is redirected for %s to the configured page with a token, stored as a hash only",
    async (role) => {
      const t = await start();
      t.as(role);

      const response = await t.post({ "sec-fetch-site": "same-origin" });

      expect(response.status).toBe(303);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const location = new URL(response.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(PLAN_PAGE);
      expect([...location.searchParams.keys()]).toEqual(["handoff"]);
      const token = tokenOf(response);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const rows = await t.tokens();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        token_hash: createHash("sha256").update(token).digest("hex"),
        workspace_id: t.alpha.id,
        user_id: `${role}-alpha`,
        role,
        used_at: null,
        revoked_at: null,
      });
      expect(JSON.stringify(rows)).not.toContain(token);
      const lifetime =
        Date.parse(rows[0]?.expires_at ?? "") -
        Date.parse(rows[0]?.created_at ?? "");
      expect(lifetime).toBe(5 * 60 * 1000);
    },
  );

  // #284-T02
  it("is redirected to the address of the setting whatever the request says", async () => {
    const t = await start();
    t.as("owner");

    const response = await t.post(
      {
        "sec-fetch-site": "same-origin",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        referer: "https://evil.example/",
      },
      "alpha",
      "?redirect=https://evil.example&next=//evil.example&handoff=forged",
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://plans.example");
    expect(location.pathname).toBe("/manage");
    expect(location.searchParams.getAll("handoff")).toEqual([
      tokenOf(response),
    ]);
    expect(tokenOf(response)).not.toBe("forged");
  });

  // #284-T12
  it("makes the token of an earlier click useless", async () => {
    const t = await start();
    t.as("owner");
    const first = tokenOf(await t.post());
    const second = tokenOf(await t.post());
    const redeem = createPlanHandoffRedeemRepository(t.db);
    const hash = (token: string) =>
      createHash("sha256").update(token).digest("hex");

    expect(await redeem.redeem(hash(first))).toBeUndefined();
    expect(await redeem.redeem(hash(second))).toMatchObject({
      userId: "owner-alpha",
      role: "owner",
    });
  });
});

describe("everybody else", () => {
  // #284-T06
  it("refuses a Member like any role-restricted route, and makes no token", async () => {
    const t = await start();
    t.as("member");

    const response = await t.post({ "sec-fetch-site": "same-origin" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(response.headers.get("location")).toBeNull();
    expect(await t.tokens()).toEqual([]);
  });

  // #284-T06
  it("answers a member of another workspace as for a workspace that is not there", async () => {
    const t = await start();
    t.asOutsider();

    const response = await t.post({ "sec-fetch-site": "same-origin" });

    expect(response.status).toBe(404);
    expect(await t.tokens()).toEqual([]);
  });

  // #284-T06
  it("answers somebody who is not signed in with 401", async () => {
    const t = await start();
    t.asNobody();

    const response = await t.post({ "sec-fetch-site": "same-origin" });

    expect(response.status).toBe(401);
    expect(await t.tokens()).toEqual([]);
  });

  // #284-T07
  it.each([
    ["cross-site", { "sec-fetch-site": "cross-site" }],
    ["same-site (a sibling subdomain)", { "sec-fetch-site": "same-site" }],
    ["an Origin of another host", { origin: "https://evil.example" }],
    ["an Origin that is null", { origin: "null" }],
  ])(
    "refuses a request that is %s, and makes no token",
    async (_name, headers) => {
      const t = await start();
      t.as("owner");

      const response = await t.post(headers);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "cross_site_request" });
      expect(response.headers.get("location")).toBeNull();
      expect(await t.tokens()).toEqual([]);
    },
  );

  // #284-T07
  it("accepts a request from the page itself (same Origin)", async () => {
    const t = await start();
    t.as("owner");

    const response = await t.post({
      origin: "https://app.test",
      host: "app.test",
    });

    expect(response.status).toBe(303);
  });
});

describe("the limit", () => {
  // #284-T08
  it("refuses the request after too many clicks with Retry-After, and makes no more tokens", async () => {
    const t = await start();
    t.as("owner");
    for (let click = 0; click < PLAN_HANDOFF_MAX; click += 1)
      expect((await t.post()).status).toBe(303);

    const refused = await t.post();

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("location")).toBeNull();
    expect(await t.tokens()).toHaveLength(PLAN_HANDOFF_MAX);
  });

  // #284-T08
  it("counts per person and workspace: another person is not held back", async () => {
    const t = await start();
    t.as("owner");
    for (let click = 0; click <= PLAN_HANDOFF_MAX; click += 1) await t.post();

    t.as("admin");

    expect((await t.post()).status).toBe(303);
  });
});

describe("what leaves the app", () => {
  // #284-T10
  it("logs the workspace and the result, never the token", async () => {
    const t = await start();
    t.as("owner");
    const token = tokenOf(await t.post());
    for (let click = 0; click < PLAN_HANDOFF_MAX; click += 1) await t.post();

    const log = logged.join("\n");

    expect(log).toContain(`[plan-handoff] workspace=${t.alpha.id} result=ok`);
    expect(log).toContain(
      `[plan-handoff] workspace=${t.alpha.id} result=rate_limited`,
    );
    expect(log).not.toContain(token);
    expect(log).not.toContain("owner-alpha@example.test");
  });
});
