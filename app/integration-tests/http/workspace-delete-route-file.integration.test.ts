// SPDX-License-Identifier: Apache-2.0

// The real route file of the deletion of a workspace (#658) with the wiring the running server uses: the dynamic segment, the
// database opened at start, the workspace access and the service on top of it. Only the session lookup and `connection()` are
// replaced (they need Next.js's request scope). The service decides again from the database whether the person is an Owner, so
// an Admin is refused with the same answer whether the route guard (`withWorkspace(…, "delete_workspace", …)`) or the service
// refuses; this file therefore watches the handler as well: for a person below the Owner it must never be reached. A route
// whose permission was loosened (to `view`, say) fails here, not in a table that is built from the same permission.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";
import { DELETE } from "../../src/app/api/w/[workspace]/route.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
const reached = vi.hoisted(() => ({ deleteWorkspace: vi.fn<() => void>() }));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));
vi.mock("@/workspaces/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/workspaces/shared")>();
  return {
    ...actual,
    getWorkspaceRouteHandlers() {
      const handlers = actual.getWorkspaceRouteHandlers();
      return {
        ...handlers,
        deleteWorkspace(...args: Parameters<typeof handlers.deleteWorkspace>) {
          reached.deleteWorkspace();
          return handlers.deleteWorkspace(...args);
        },
      };
    },
  };
});

async function startRoute() {
  reached.deleteWorkspace.mockClear();
  vi.stubEnv("BETTER_AUTH_URL", "https://app.test");
  vi.stubEnv("APP_SECRET", "delete-route-test-secret-0123456789-0123456789");
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const signIn = async (role: "owner" | "admin" | "member") =>
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: `${role}-1`, workspaceId, role }),
    );
  for (const role of ["owner", "admin", "member"] as const) await signIn(role);
  const call = (confirmName: string, workspace = "default") =>
    DELETE(
      new Request(`https://app.test/api/w/${workspace}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
        },
        body: JSON.stringify({ confirmName }),
      }),
      { params: Promise.resolve({ workspace }) } as Parameters<
        typeof DELETE
      >[1],
    );
  const deletedAt = async () =>
    (
      await db
        .selectFrom("workspaces")
        .select("deleted_at")
        .where("id", "=", workspaceId)
        .executeTakeFirstOrThrow()
    ).deleted_at;
  return { db, signIn, call, deletedAt };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the deletion route of a workspace", () => {
  // #658-T02
  it.each(["member", "admin"] as const)(
    "refuses a %s at the door of the route: the handler is never reached and nothing is deleted",
    async (role) => {
      const t = await startRoute();
      await t.signIn(role);

      const response = await t.call("Default workspace");

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(reached.deleteWorkspace).not.toHaveBeenCalled();
      expect(await t.deletedAt()).toBeNull();
    },
  );

  // #658-T02
  it("lets an Owner through to the handler, which checks the name", async () => {
    const t = await startRoute();
    await t.signIn("owner");

    const response = await t.call("another name");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "name_mismatch" });
    expect(reached.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(await t.deletedAt()).toBeNull();
  });

  // #658-T03
  it("deletes the workspace for an Owner who types its name, and the address is a missing page afterwards", async () => {
    const t = await startRoute();
    await t.signIn("owner");

    const response = await t.call("Default workspace");
    const again = await t.call("Default workspace");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await t.deletedAt()).not.toBeNull();
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "not_found" });
  });
});
