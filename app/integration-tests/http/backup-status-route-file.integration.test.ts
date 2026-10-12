// SPDX-License-Identifier: Apache-2.0

// Pins down the real route file `GET /api/backup/status` behind the proxy: the status of the backups is the
// instance admin's alone, so the route asks for the admin itself (the second guard; the proxy in front is
// pinned down by src/auth/access-proxy.test.ts and src/admin/guard.integration.test.ts). Only the session
// lookup and the redirect and not-found signals of Next.js are replaced. An Owner of a workspace who does not
// run the instance gets the answer of a path that does not exist and learns nothing of the backups; if the
// check is taken out of the route, these tests fail.
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
import {
  defaultWorkspaceId,
  markInstanceSetUp,
} from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));
// The signals of Next.js are thrown; here they are errors the test can recognize.
class NotFoundSignal extends Error {}
class RedirectSignal extends Error {}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: () => {
    throw new NotFoundSignal("not found");
  },
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

async function startRoute() {
  vi.stubEnv("BACKUP_DIR", await createTestDirectory());
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  await markInstanceSetUp(getDatabase());
  vi.resetModules();
  return import("../../src/app/api/backup/status/route.ts");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the backup status route file", () => {
  it("answers the instance admin with the picture of the backups", async () => {
    const route = await startRoute();
    session.currentLookup.mockResolvedValue(
      await signedInMember(getDatabase(), {
        id: "root",
        isInstanceAdmin: true,
      }),
    );

    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schedule: { enabled: expect.any(Boolean) },
      backupCount: 0,
    });
  });

  // #101-WM-08
  it("is a path that does not exist for the Owner of a workspace who does not run the instance", async () => {
    const route = await startRoute();
    session.currentLookup.mockResolvedValue(
      await signedInMember(getDatabase(), {
        id: "owner-only",
        workspaceId: await defaultWorkspaceId(getDatabase()),
        role: "owner",
      }),
    );

    await expect(route.GET()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  // #101-WM-08
  it("is a path that does not exist for a Member and for a person without a workspace either", async () => {
    const route = await startRoute();
    for (const options of [
      {
        id: "plain-member",
        workspaceId: await defaultWorkspaceId(getDatabase()),
        role: "member" as const,
      },
      { id: "outsider" },
    ]) {
      session.currentLookup.mockResolvedValue(
        await signedInMember(getDatabase(), options),
      );

      await expect(route.GET()).rejects.toBeInstanceOf(NotFoundSignal);
    }
  });

  it("sends a request without a session to the sign-in, which the proxy would have answered first", async () => {
    const route = await startRoute();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    await expect(route.GET()).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("exports only the GET method", async () => {
    const route = await startRoute();

    expect(Object.keys(route).sort()).toEqual(["GET"]);
  });
});
