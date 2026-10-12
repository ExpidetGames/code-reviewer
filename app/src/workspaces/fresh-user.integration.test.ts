// SPDX-License-Identifier: Apache-2.0

// What a person sees who has an account but no workspace, through the real proxy, the real Better Auth and a
// real SQLite file: in a single-tenant instance, which has the one workspace its setup made, they see
// nothing of it and are never joined to it. The interim guard that kept new accounts away from the data is
// gone; this is what keeps them away now (the membership). The routes and pages made for exactly this
// person stay open to them, and nothing else does.
import { describe, expect, it } from "vitest";
import {
  createAdminHarness,
  MISSING_ANSWER_MARKER,
} from "../test-support/admin-harness.ts";

const FRESH = { email: "fresh@example.com", password: "k4Pq-v8Zm2Xw" };

async function start() {
  const portal = await createAdminHarness();
  await portal.createUser({
    id: "fresh-1",
    ...FRESH,
    emailVerified: true,
    member: false,
  });
  const cookies = await portal.signIn(FRESH.email, FRESH.password);
  return { portal, cookies };
}

async function location(response: Response): Promise<string | null> {
  const target = response.headers.get("location");
  return target === null ? null : new URL(target).pathname;
}

describe("a fresh account in a single-tenant instance", () => {
  // #101-WM-02
  it("is sent to the page that asks for an invitation by every page of the app and of the default workspace", async () => {
    const { portal, cookies } = await start();
    const workspace = await portal.db
      .selectFrom("workspaces")
      .select("slug")
      .executeTakeFirstOrThrow();

    for (const path of [
      "/",
      "/projects",
      "/runs",
      `/w/${workspace.slug}/projects`,
      `/w/${workspace.slug}/runs`,
      `/w/${workspace.slug}/members`,
      `/w/${workspace.slug}/settings`,
    ]) {
      const response = await portal.visit(path, { cookies });
      expect(response.status, path).toBe(307);
      expect(await location(response), path).toBe("/no-access");
    }
  });

  // #101-WM-02
  it("is refused by every data route of the default workspace with 403 no_workspace_access", async () => {
    const { portal, cookies } = await start();
    const workspace = await portal.db
      .selectFrom("workspaces")
      .select("slug")
      .executeTakeFirstOrThrow();

    for (const [path, method] of [
      [`/api/w/${workspace.slug}/runs`, "GET"],
      [`/api/w/${workspace.slug}/review-settings`, "GET"],
      [`/api/w/${workspace.slug}/review-settings`, "PUT"],
      [`/api/w/${workspace.slug}/invitations`, "POST"],
      [`/api/w/${workspace.slug}/members/${portal.adminId}`, "DELETE"],
      [`/api/w/${workspace.slug}`, "PATCH"],
    ] as const) {
      const response = await portal.visit(path, { cookies, method });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json(), `${method} ${path}`).toEqual({
        error: "no_workspace_access",
      });
    }
  });

  // #101-WM-02
  it("is never joined to the workspace: no membership row exists, whatever they open", async () => {
    const { portal, cookies } = await start();
    for (const path of ["/", "/no-access", "/projects", "/invitations"])
      await portal.visit(path, { cookies });
    await portal.visit("/api/workspaces", {
      cookies,
      method: "POST",
      body: { name: "Mine" },
    });

    const rows = await portal.db
      .selectFrom("workspace_members")
      .select("user_id")
      .where("user_id", "=", "fresh-1")
      .execute();
    expect(rows).toEqual([]);
  });

  // #101-WM-01
  it("reaches the page that says what to do, the list of invitations, and the two routes that create a workspace and accept an invitation", async () => {
    const { portal, cookies } = await start();

    for (const [path, method] of [
      ["/no-access", "GET"],
      ["/invitations", "GET"],
      ["/workspaces/new", "GET"],
      ["/api/workspaces", "POST"],
      ["/api/invitations/accept", "POST"],
    ] as const) {
      const response = await portal.visit(path, { cookies, method });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe("reached");
    }
  });

  // #101-WM-02
  it("gets nothing of the admin portal either: the answer is the one of any other path", async () => {
    const { portal, cookies } = await start();

    const portalPage = await portal.visit("/admin", { cookies });
    const missing = await portal.visit("/there-is-no-such-page", { cookies });

    expect(portalPage.status).toBe(missing.status);
    expect(await location(portalPage)).toBe(await location(missing));
  });
});

describe("a member of the default workspace", () => {
  // #101-WM-06
  it("opens the pages of their workspace, and gets the answer of a missing path for any other address", async () => {
    const portal = await createAdminHarness();
    await portal.createUser({
      id: "member-1",
      email: "member@example.com",
      password: FRESH.password,
      emailVerified: true,
    });
    const cookies = await portal.signIn("member@example.com", FRESH.password);
    const workspace = await portal.db
      .selectFrom("workspaces")
      .select("slug")
      .executeTakeFirstOrThrow();

    const own = await portal.visit(`/w/${workspace.slug}/projects`, {
      cookies,
    });
    const foreign = await portal.visit("/w/not-mine/projects", { cookies });
    const foreignApi = await portal.visit("/api/w/not-mine/runs", { cookies });

    expect(await own.text()).toBe("reached");
    // The answer of a path that is no route of the app (the harness marks it, see admin-harness.ts).
    for (const response of [foreign, foreignApi]) {
      expect(response.status).toBe(404);
      expect(response.headers.get(MISSING_ANSWER_MARKER)).toBe("1");
    }
  });

  // #101-WM-06
  it("is turned away from the workspace at once when removed, with the session they already hold", async () => {
    const portal = await createAdminHarness();
    await portal.createUser({
      id: "member-1",
      email: "member@example.com",
      password: FRESH.password,
      emailVerified: true,
    });
    const cookies = await portal.signIn("member@example.com", FRESH.password);
    const workspace = await portal.db
      .selectFrom("workspaces")
      .select("slug")
      .executeTakeFirstOrThrow();
    expect(
      await (
        await portal.visit(`/w/${workspace.slug}/runs`, { cookies })
      ).text(),
    ).toBe("reached");

    await portal.db
      .deleteFrom("workspace_members")
      .where("user_id", "=", "member-1")
      .execute();
    const after = await portal.visit(`/w/${workspace.slug}/runs`, { cookies });

    expect(after.status).toBe(307);
    expect(await location(after)).toBe("/no-access");
  });
});
