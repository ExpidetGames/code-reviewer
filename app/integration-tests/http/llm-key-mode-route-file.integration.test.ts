// SPDX-License-Identifier: Apache-2.0

// Pins down the real route file `GET` and `PUT /api/w/:workspace/llm-key-mode` (#496) with the wiring the running server uses: the
// database opened at start and the workspace access of the session. Only the session lookup and `connection()` are replaced (they
// need Next.js's request scope). Every member reads the choice; only an Owner or an Admin sets it, so the permission of the route
// file itself (`manage_llm_key`) is what a Member runs into, not a check of a handler that a test wired by hand.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import {
  GET,
  PUT,
} from "../../src/app/api/w/[workspace]/llm-key-mode/route.ts";
import { createLlmKeyModeStore } from "../../src/llm/key-mode-store.ts";
import { setBillingSwitch } from "../../src/test-support/billing-switch.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

async function startRoute(role: "member" | "admin" | "owner") {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  await setBillingSwitch(db, true);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, { workspaceId, role }),
  );
  return { db, workspaceId };
}

const read = (workspace: string) =>
  GET(new Request(`https://app.test/api/w/${workspace}/llm-key-mode`), {
    params: Promise.resolve({ workspace }),
  } as Parameters<typeof GET>[1]);

const change = (workspace: string, keyMode: string) =>
  PUT(
    new Request(`https://app.test/api/w/${workspace}/llm-key-mode`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ keyMode }),
    }),
    {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof PUT>[1],
  );

afterEach(async () => {
  await closeDatabase();
});

describe("the key mode route file", () => {
  // #496-T13
  it("refuses a Member who changes the key mode with 403 and stores nothing", async () => {
    const { db, workspaceId } = await startRoute("member");

    const response = await change("default", "managed");

    expect(response.status).toBe(403);
    expect(await createLlmKeyModeStore(db, workspaceId).get()).toBeUndefined();
  });

  // #496-T13
  it("refuses a Member at the access check of the route file, before the body is read or the service is asked", async () => {
    await startRoute("member");

    // A body the handler would refuse with 415: a Member that gets 403 never reached the handler.
    const response = await PUT(
      new Request("https://app.test/api/w/default/llm-key-mode", {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "sec-fetch-site": "same-origin",
        },
        body: "managed",
      }),
      {
        params: Promise.resolve({ workspace: "default" }),
      } as Parameters<typeof PUT>[1],
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  // #496-T13
  it.each(["admin", "owner"] as const)(
    "lets %s change the key mode",
    async (role) => {
      const { db, workspaceId } = await startRoute(role);

      const response = await change("default", "managed");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ keyMode: "managed" });
      expect(await createLlmKeyModeStore(db, workspaceId).get()).toBe(
        "managed",
      );
    },
  );

  // #496-T13
  it("lets a Member read the choice", async () => {
    await startRoute("member");

    const response = await read("default");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keyMode: "managed" });
  });
});
