// SPDX-License-Identifier: Apache-2.0

// Pins down how the access proxy treats the files of the admin portal: the instance admin's request is
// rewritten to them with a mark only this proxy knows, a request for them by their own address is marked
// as one for a path that does not exist (whoever asks, the admin too), and the mark is compared in
// constant time. The real requests through the real proxy, with a database and Better Auth, are in
// src/admin/guard.integration.test.ts and e2e/admin/admin-portal.e2e.ts.
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { PORTAL_DENIED_HEADER } from "../admin/paths.ts";
import type { AccessGates } from "./access-gates.ts";
import type { AccessPolicy } from "./access-policy.ts";
import { PORTAL_REWRITE_HEADER, createAccessProxy } from "./access-proxy.ts";
import type { SessionLookup } from "./session-user.ts";

type SessionUser = Extract<SessionLookup, { kind: "user" }>["user"];

// The real function would look the session up in Better Auth; these tests decide who is asking.
const lookupSession = vi.hoisted(() => vi.fn());
vi.mock("./session-user.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-user.ts")>()),
  lookupSession,
}));

// Wraps the real function, so a test can see that it is the one that compares the mark.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const { timingSafeEqual } = await import("node:crypto");

const BASE = "http://localhost:3000";
const REQUEST_HEADER = (name: string) => `x-middleware-request-${name}`;

function aUser(isInstanceAdmin: boolean): SessionLookup {
  const user: SessionUser = {
    id: "u1",
    name: "A Person",
    email: "person@example.com",
    isInstanceAdmin,
    githubLogin: null,
    githubId: null,
    image: null,
    orgCheckedAt: null,
    orgCheckedFor: null,
  };
  return { kind: "user", user };
}

function newProxy(
  gates: Partial<AccessGates> = {},
): ReturnType<typeof createAccessProxy> {
  return createAccessProxy({
    // Never used: the session lookup is replaced above.
    getAuth: () => undefined as never,
    getPolicy: () => undefined as unknown as AccessPolicy,
    // The proxy asks the gates only about a workspace address (and the session lookup, which is replaced
    // above, asks the others).
    getGates: () => gates as AccessGates,
  });
}

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, { headers });
}

/** The mark the proxy gave the instance admin's rewrite. */
async function markOf(proxy: ReturnType<typeof newProxy>): Promise<string> {
  lookupSession.mockResolvedValue(aUser(true));
  const response = await proxy(request("/admin/setup"));
  const mark = response.headers.get(REQUEST_HEADER(PORTAL_REWRITE_HEADER));
  if (mark === null) throw new Error("the admin's request was not rewritten");
  return mark;
}

function isMarkedAsMissing(response: Response): boolean {
  return (
    response.headers.get("x-middleware-next") === "1" &&
    response.headers.get(REQUEST_HEADER(PORTAL_DENIED_HEADER)) === "1" &&
    response.headers.get("x-middleware-rewrite") === null
  );
}

function wentOnUntouched(response: Response): boolean {
  return (
    response.headers.get("x-middleware-next") === "1" &&
    response.headers.get(REQUEST_HEADER(PORTAL_DENIED_HEADER)) === null
  );
}

describe("the mark of the portal rewrite", () => {
  // #138
  it("is a long random value that is new for every proxy", async () => {
    const marks = await Promise.all([
      markOf(newProxy()),
      markOf(newProxy()),
      markOf(newProxy()),
    ]);

    expect(new Set(marks).size).toBe(3);
    for (const mark of marks) expect(mark.length).toBeGreaterThanOrEqual(32);
  });

  // #138
  it("is the same for every request of one proxy, and the rewritten request is let through with it", async () => {
    const proxy = newProxy();
    const mark = await markOf(proxy);
    expect(await markOf(proxy)).toBe(mark);

    lookupSession.mockResolvedValue(aUser(true));
    const response = await proxy(
      request("/instance-portal/setup", { [PORTAL_REWRITE_HEADER]: mark }),
    );

    expect(wentOnUntouched(response)).toBe(true);
  });

  // #138
  it("is not accepted from another proxy: a constant mark would be", async () => {
    const other = newProxy();
    const stolen = await markOf(other);
    const proxy = newProxy();
    lookupSession.mockResolvedValue(aUser(true));

    const response = await proxy(
      request("/instance-portal/setup", { [PORTAL_REWRITE_HEADER]: stolen }),
    );

    expect(isMarkedAsMissing(response)).toBe(true);
  });

  // #138
  it.each([
    ["nothing", undefined],
    ["an empty value", ""],
    ["a short value", "x"],
    ["the mark with a character added", (mark: string) => `${mark}x`],
    ["the mark with a character cut off", (mark: string) => mark.slice(1)],
    [
      "a value as long as the mark",
      (mark: string) => (mark.startsWith("A") ? "B" : "A") + mark.slice(1),
    ],
    ["a very long value", () => "A".repeat(100_000)],
  ])("is refused when the request carries %s", async (_name, wrong) => {
    const proxy = newProxy();
    const mark = await markOf(proxy);
    const sent: Record<string, string> =
      wrong === undefined
        ? {}
        : {
            [PORTAL_REWRITE_HEADER]:
              typeof wrong === "function" ? wrong(mark) : wrong,
          };

    const response = await proxy(request("/instance-portal/setup", sent));

    expect(isMarkedAsMissing(response)).toBe(true);
  });

  // #138
  it("is compared with timingSafeEqual, whatever the length of what was sent", async () => {
    const proxy = newProxy();
    const mark = await markOf(proxy);
    vi.mocked(timingSafeEqual).mockClear();

    await proxy(
      request("/instance-portal", { [PORTAL_REWRITE_HEADER]: "short" }),
    );
    await proxy(
      request("/instance-portal", { [PORTAL_REWRITE_HEADER]: `${mark}more` }),
    );
    await proxy(request("/instance-portal", { [PORTAL_REWRITE_HEADER]: mark }));

    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
    // The two sides are of one length, which is what the function demands (it throws otherwise).
    for (const [left, right] of vi.mocked(timingSafeEqual).mock.calls)
      expect(Buffer.byteLength(left as Buffer)).toBe(
        Buffer.byteLength(right as Buffer),
      );
  });
});

describe("a request for the files of the portal by their own address", () => {
  // #138
  it.each([
    "/instance-portal",
    "/instance-portal/setup",
    "/api/instance-portal/settings",
    "/%69nstance-portal/setup",
  ])(
    "goes on marked as one for a missing path, for a person who is not an admin (%s)",
    async (path) => {
      lookupSession.mockResolvedValue(aUser(false));

      const response = await newProxy()(request(path));

      expect(isMarkedAsMissing(response)).toBe(true);
    },
  );

  // #138
  it.each(["/instance-portal", "/api/instance-portal/settings"])(
    "goes on marked as one for a missing path for the instance admin too (%s)",
    async (path) => {
      lookupSession.mockResolvedValue(aUser(true));

      const response = await newProxy()(request(path));

      expect(isMarkedAsMissing(response)).toBe(true);
    },
  );

  // #138
  it("is sent to the login without a session, as any other path is", async () => {
    lookupSession.mockResolvedValue({ kind: "none" });

    const response = await newProxy()(request("/instance-portal"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/login",
    );
  });
});

describe("the header that marks a request as one for a missing path", () => {
  // #138
  it.each([
    ["a page", "/w/acme/projects"],
    ["a public page", "/login"],
    ["the portal's address", "/admin/setup"],
  ])(
    "is taken off a request that arrives with it from outside (%s)",
    async (_name, path) => {
      lookupSession.mockResolvedValue(aUser(true));

      const response = await newProxy({
        workspaceRole: () => Promise.resolve("member"),
      })(request(path, { [PORTAL_DENIED_HEADER]: "1" }));

      // The proxy lists the request headers that go on; without a list the request goes on as it came.
      const kept = response.headers.get("x-middleware-override-headers");
      expect(kept).not.toBeNull();
      expect((kept ?? "").split(",")).not.toContain(PORTAL_DENIED_HEADER);
      expect(response.headers.get(REQUEST_HEADER(PORTAL_DENIED_HEADER))).toBe(
        null,
      );
    },
  );
});

describe("a request for a workspace address", () => {
  const roleOf = (role: "owner" | "admin" | "member" | null) =>
    vi.fn((...args: [string, string]) => {
      void args;
      return Promise.resolve(role);
    });

  // #101-WM-06
  it.each([
    "/w/acme",
    "/w/acme/projects",
    "/w/acme/runs/42",
    "/api/w/acme/runs",
    "/api/w/acme/repositories/7/project",
  ])("goes on untouched for a member of the workspace (%s)", async (path) => {
    lookupSession.mockResolvedValue(aUser(false));
    const workspaceRole = roleOf("member");

    const response = await newProxy({ workspaceRole })(request(path));

    expect(wentOnUntouched(response)).toBe(true);
    expect(workspaceRole).toHaveBeenCalledWith("u1", "acme");
  });

  // #101-WM-06, #101-WM-07
  it.each([
    "/w/acme",
    "/w/acme/projects",
    "/w/acme/members",
    "/api/w/acme/runs",
    "/api/w/acme/invitations",
    "/api/w/acme/members/someone",
  ])(
    "goes on marked as one for a missing path for a person who does not belong to the workspace (%s), the instance admin included",
    async (path) => {
      for (const isAdmin of [false, true]) {
        lookupSession.mockResolvedValue(aUser(isAdmin));

        const response = await newProxy({ workspaceRole: roleOf(null) })(
          request(path),
        );

        expect(isMarkedAsMissing(response), path).toBe(true);
      }
    },
  );

  // #101-WM-06
  it.each([
    "/w/ACME/projects",
    "/w/-x/projects",
    "/w/a_b/runs",
    "/api/w/a%2Fb/runs",
  ])(
    "is a missing path when the address is not shaped like a workspace, without asking the database (%s)",
    async (path) => {
      lookupSession.mockResolvedValue(aUser(false));
      const workspaceRole = roleOf("owner");

      const response = await newProxy({ workspaceRole })(request(path));

      expect(isMarkedAsMissing(response)).toBe(true);
      expect(workspaceRole).not.toHaveBeenCalled();
    },
  );

  // #101-WM-06
  it("answers a workspace that does not exist exactly like one the person does not belong to", async () => {
    lookupSession.mockResolvedValue(aUser(false));
    const proxy = newProxy({ workspaceRole: roleOf(null) });

    const theirs = await proxy(request("/api/w/acme/runs"));
    const nothing = await proxy(request("/api/w/no-such-one/runs"));

    expect(isMarkedAsMissing(theirs)).toBe(true);
    expect(isMarkedAsMissing(nothing)).toBe(true);
    expect([...theirs.headers.keys()].sort()).toEqual(
      [...nothing.headers.keys()].sort(),
    );
  });

  // #101-WM-06
  it("refuses with 503 when the membership cannot be read, instead of letting the request through", async () => {
    lookupSession.mockResolvedValue(aUser(false));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const workspaceRole = vi.fn(() => Promise.reject(new Error("db is gone")));

    const response = await newProxy({ workspaceRole })(
      request("/w/acme/projects"),
    );

    expect(response.status).toBe(503);
    error.mockRestore();
  });

  it("is sent to the login without a session, and a data route answers 401", async () => {
    lookupSession.mockResolvedValue({ kind: "none" });
    const workspaceRole = roleOf("owner");
    const proxy = newProxy({ workspaceRole });

    const page = await proxy(request("/w/acme/projects"));
    const data = await proxy(request("/api/w/acme/runs"));

    expect(page.status).toBe(307);
    expect(data.status).toBe(401);
    expect(workspaceRole).not.toHaveBeenCalled();
  });
});

describe("a person without a workspace", () => {
  const without = (): SessionLookup => ({
    kind: "no_workspace",
    user: (aUser(false) as { user: SessionUser }).user,
  });

  // #101-WM-02
  it.each(["/api/w/acme/runs", "/api/w/acme/invitations"])(
    "is refused by every data route with 403 no_workspace_access (%s)",
    async (path) => {
      lookupSession.mockResolvedValue(without());

      const response = await newProxy()(request(path));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "no_workspace_access" });
    },
  );

  // #101-WM-01, #101-WM-02
  it.each(["/w/acme/projects", "/projects", "/", "/runs", "/admin"])(
    "is sent to the page that says what to do by %s",
    async (path) => {
      lookupSession.mockResolvedValue(without());

      const response = await newProxy()(request(path));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
        "/no-access",
      );
    },
  );

  // #101-WM-01
  it.each([
    "/no-access",
    "/invitations",
    "/workspaces/new",
    "/api/workspaces",
    "/api/invitations/accept",
  ])("reaches %s, which is made for them", async (path) => {
    lookupSession.mockResolvedValue(without());

    const response = await newProxy()(request(path));

    expect(wentOnUntouched(response)).toBe(true);
  });

  // #101-WM-02
  it.each([
    "/no-access/",
    "/no-access/x",
    "/api/workspaces/x",
    "/api/invitations",
    "/api/invitations/accept/x",
    "/workspaces",
    "/invitations/x",
  ])("reaches nothing that only looks like those (%s)", async (path) => {
    lookupSession.mockResolvedValue(without());

    const response = await newProxy()(request(path));

    expect(wentOnUntouched(response)).toBe(false);
  });
});

describe("a route that is the instance admin's alone, outside the portal", () => {
  const ROUTE = "/api/backup/status";

  // #101-WM-08
  it("goes on marked as one for a missing path for a signed in person who is not the instance admin", async () => {
    lookupSession.mockResolvedValue(aUser(false));

    const response = await newProxy({ workspaceRole: vi.fn() })(request(ROUTE));

    expect(isMarkedAsMissing(response)).toBe(true);
  });

  // #101-WM-08
  it("answers a person who has to verify the address or has no workspace as it answers every other data route", async () => {
    const user = (aUser(false) as { user: SessionUser }).user;
    lookupSession.mockResolvedValue({ kind: "unverified", user });
    const unverified = await newProxy()(request(ROUTE));
    lookupSession.mockResolvedValue({ kind: "no_workspace", user });
    const without = await newProxy()(request(ROUTE));

    expect(unverified.status).toBe(403);
    expect(await unverified.json()).toEqual({ error: "email_not_verified" });
    expect(without.status).toBe(403);
    expect(await without.json()).toEqual({ error: "no_workspace_access" });
  });

  // #101-WM-08
  it("goes on untouched for the instance admin, also with an address still to verify", async () => {
    lookupSession.mockResolvedValue(aUser(true));
    const verified = await newProxy()(request(ROUTE));
    lookupSession.mockResolvedValue({
      kind: "unverified",
      user: (aUser(true) as { user: SessionUser }).user,
    } satisfies SessionLookup);
    const unverified = await newProxy()(request(ROUTE));

    expect(wentOnUntouched(verified)).toBe(true);
    expect(wentOnUntouched(unverified)).toBe(true);
  });

  // #101-WM-08
  it("is turned away without a session as every protected data route is, with 401", async () => {
    lookupSession.mockResolvedValue({ kind: "none" } satisfies SessionLookup);

    const response = await newProxy()(request(ROUTE));

    expect(response.status).toBe(401);
  });

  // #101-WM-08
  it.each([
    "/api//backup/status",
    "/api/%62ackup/status",
    "/api/backup/./status",
  ])("is recognized however the path is spelled (%s)", async (path) => {
    lookupSession.mockResolvedValue(aUser(false));

    const response = await newProxy({ workspaceRole: vi.fn() })(request(path));

    expect(isMarkedAsMissing(response), path).toBe(true);
  });
});

describe("an address from before the workspace was in the address", () => {
  const firstWorkspaceSlug = (slug: string | null) =>
    vi.fn((...args: [string]) => {
      void args;
      return Promise.resolve(slug);
    });

  // #101-WM-05
  it.each([
    ["/", "/w/acme/projects"],
    ["/projects", "/w/acme/projects"],
    ["/projects/42", "/w/acme/projects/42"],
    ["/projects/a%2Fb", "/w/acme/projects/a%2Fb"],
    ["/runs", "/w/acme/runs"],
    ["/runs/r-1", "/w/acme/runs/r-1"],
    ["/settings", "/w/acme/settings"],
  ])(
    "is a real 307 redirect to the same page of the first workspace of the person (%s)",
    async (path, target) => {
      lookupSession.mockResolvedValue(aUser(false));
      const gate = firstWorkspaceSlug("acme");

      const response = await newProxy({ firstWorkspaceSlug: gate })(
        request(`${path}?tab=2`),
      );

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe(BASE);
      expect(location.pathname + location.search).toBe(`${target}?tab=2`);
      expect(gate).toHaveBeenCalledWith("u1");
    },
  );

  // #101-WM-05
  it.each([
    "/projectsx",
    "/runs-old",
    "/settings2",
    "/w/acme/projects",
    "/api/w/acme/runs",
    "/no-access",
  ])("leaves %s alone", async (path) => {
    lookupSession.mockResolvedValue(aUser(false));
    const gate = firstWorkspaceSlug("acme");

    const response = await newProxy({
      firstWorkspaceSlug: gate,
      workspaceRole: () => Promise.resolve("member"),
    })(request(path));

    expect(response.status).not.toBe(307);
    expect(gate).not.toHaveBeenCalled();
  });

  // #101-WM-05
  it("goes on to the page when the person has no workspace to lead to (the instance admin of a new multi-tenant instance)", async () => {
    lookupSession.mockResolvedValue(aUser(true));

    const response = await newProxy({
      firstWorkspaceSlug: firstWorkspaceSlug(null),
    })(request("/projects"));

    expect(wentOnUntouched(response)).toBe(true);
  });

  // #101-WM-05
  it("does not redirect a visitor without a session, who is sent to the sign-in as before", async () => {
    lookupSession.mockResolvedValue({ kind: "none" } satisfies SessionLookup);
    const gate = firstWorkspaceSlug("acme");

    const response = await newProxy({ firstWorkspaceSlug: gate })(
      request("/projects"),
    );

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/login",
    );
    expect(gate).not.toHaveBeenCalled();
  });

  it("refuses with 503 when the workspace cannot be read", async () => {
    lookupSession.mockResolvedValue(aUser(false));

    const response = await newProxy({
      firstWorkspaceSlug: () => Promise.reject(new Error("database is down")),
    })(request("/projects"));

    expect(response.status).toBe(503);
  });
});
