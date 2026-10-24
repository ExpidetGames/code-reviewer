// SPDX-License-Identifier: LicenseRef-Proprietary

// #496: `GET` and `PUT /api/w/:workspace/llm-key-mode` as the app wires them (guard, access, body, service), over a real database and
// the real matrix of roles. An Owner and an Admin (`manage_llm_key`) choose whose key the workspace's reviews run on; a Member reads
// the choice and gets 403 on a change, with nothing stored and nothing logged. The choice exists only while billing is on, and a
// workspace without a key of its own cannot choose to use it.
import { describe, expect, it, vi } from "vitest";
import { isBillingOn } from "../billing/enabled.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { signedInMember } from "../test-support/session-lookup.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { resolveWorkspaceAccess } from "../workspaces/access.ts";
import { accessRefusal } from "../workspaces/access-response.ts";
import type { WorkspaceAction } from "../workspaces/permissions.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { createWorkspaceLlm } from "./assemble.ts";
import { createLlmKeyModeRoute } from "./key-mode-http.ts";
import { createLlmKeyModeStore } from "./key-mode-store.ts";
import { createLlmKeyModeService } from "./key-mode-service.ts";

const BASE_URL = "https://app.example.test";
const APP_SECRET = "key-mode-http-test-app-secret-0123456789-01";

class NotFound extends Error {}

async function start(options: { billingOn?: boolean; ownKey?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "acme");
  const otherWorkspaceId = await addWorkspace(db, "other");
  await setBillingSwitch(db, options.billingOn ?? true);
  const llm = createWorkspaceLlm({
    db,
    appSecret: () => APP_SECRET,
    env: () => ({ LLM_MODEL: "vendor/model" }),
  });
  if (options.ownKey !== false)
    expect(
      (
        await llm
          .keyServiceFor(workspaceId)
          .save(
            { provider: "openrouter", apiKey: "sk-or-v1-own-0000000000000000" },
            null,
          )
      ).ok,
    ).toBe(true);
  const logs: string[] = [];
  const isOn = vi.fn(() => isBillingOn(db));
  const route = createLlmKeyModeRoute({
    guard: {
      isOn,
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    service: createLlmKeyModeService({
      db,
      keysOf: (id) => llm.keyServiceFor(id),
      log: (line) => logs.push(line),
    }),
  });
  const workspaces = createWorkspacesRepository(db);
  const as =
    (
      lookup: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" },
      action: WorkspaceAction,
      slug = "acme",
    ) =>
    (handler: Parameters<Parameters<typeof route.put>[2]>[0]) =>
      resolveWorkspaceAccess({
        lookup,
        slug,
        action,
        findMembership: (userId, name) =>
          workspaces.findMembership(userId, name),
      }).then((result) =>
        result.kind === "ok" ? handler(result.access) : accessRefusal(result),
      );
  const person = async (
    role: WorkspaceRole,
    id = `u-${role}`,
    workspace = workspaceId,
  ) => signedInMember(db, { id, workspaceId: workspace, role });
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${BASE_URL}/api/w/acme/llm-key-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = () =>
    new Request(`${BASE_URL}/api/w/acme/llm-key-mode`, { method: "GET" });
  const stored = (workspace = workspaceId) =>
    createLlmKeyModeStore(db, workspace).get();
  return {
    db,
    workspaceId,
    otherWorkspaceId,
    route,
    as,
    person,
    put,
    get,
    stored,
    isOn,
    logs,
  };
}

describe("PUT /api/w/:workspace/llm-key-mode", () => {
  // #496-T07
  it("lets an Owner choose the key, stores it, and leaves an audit line", async () => {
    const t = await start();

    const response = await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as(await t.person("owner"), "manage_llm_key"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ keyMode: "own" });
    expect(await t.stored()).toBe("own");
    expect(t.logs).toEqual([
      `[llm] KEY_MODE_CHANGED workspace=${t.workspaceId} user=u-owner key_mode=own`,
    ]);
  });

  // #496-T07
  it("lets an Admin choose the key", async () => {
    const t = await start();

    const response = await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as(await t.person("admin"), "manage_llm_key"),
    );

    expect(response.status).toBe(200);
    expect(await t.stored()).toBe("own");
  });

  // #496-T07
  it("answers a Member 403, stores nothing and leaves no audit line", async () => {
    const t = await start();

    const response = await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as(await t.person("member"), "manage_llm_key"),
    );

    expect(response.status).toBe(403);
    expect(await t.stored()).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  // #496-T07
  it("refuses a Member in the service as well, whatever the route above it asked", async () => {
    const t = await start();

    // The access check of the route is made to let a Member through (a mistake in a route file); the service still refuses.
    const response = await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as(await t.person("member"), "view"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await t.stored()).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  // #496-T07
  it("answers a person of another workspace, and nobody signed in, with the refusals of every workspace route", async () => {
    const t = await start();
    const outsider = await t.person("owner", "u-outsider", t.otherWorkspaceId);

    const outside = await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as(outsider, "manage_llm_key"),
    );
    const anonymous = await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as({ kind: "none" }, "manage_llm_key"),
    );

    expect(outside.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(await t.stored()).toBeUndefined();
    expect(await t.stored(t.otherWorkspaceId)).toBeUndefined();
  });

  // #496-T07
  it("takes the workspace from the address, never from the body", async () => {
    const t = await start();

    await t.route.put(
      t.put({
        keyMode: "own",
        workspaceId: t.otherWorkspaceId,
        workspace: "other",
      }),
      "acme",
      t.as(await t.person("owner"), "manage_llm_key"),
    );

    expect(await t.stored()).toBe("own");
    expect(await t.stored(t.otherWorkspaceId)).toBeUndefined();
  });

  // #496-T07
  it("refuses a choice of the workspace's own key when no key is stored, and keeps what was chosen", async () => {
    const t = await start({ ownKey: false });

    const response = await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as(await t.person("owner"), "manage_llm_key"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "own_key_missing" });
    expect(await t.stored()).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  // #496-T07
  it("lets a workspace without a key choose our models", async () => {
    const t = await start({ ownKey: false });

    const response = await t.route.put(
      t.put({ keyMode: "managed" }),
      "acme",
      t.as(await t.person("owner"), "manage_llm_key"),
    );

    expect(response.status).toBe(200);
    expect(await t.stored()).toBe("managed");
  });

  // #496-T07
  it("refuses anything but one of the two key modes with a stable code, and stores nothing", async () => {
    const t = await start();
    const owner = await t.person("owner");
    const attempt = async (body: unknown) => {
      const response = await t.route.put(
        t.put(body),
        "acme",
        t.as(owner, "manage_llm_key"),
      );
      return [response.status, await response.json()];
    };

    expect(await attempt({})).toEqual([422, { error: "key_mode_invalid" }]);
    expect(await attempt({ keyMode: "free" })).toEqual([
      422,
      { error: "key_mode_invalid" },
    ]);
    expect(await attempt({ keyMode: 1 })).toEqual([
      422,
      { error: "key_mode_invalid" },
    ]);
    expect(await attempt({ keyMode: null })).toEqual([
      422,
      { error: "key_mode_invalid" },
    ]);
    expect(await t.stored()).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  // #496-T07
  it("refuses a request from another site before it reads anything", async () => {
    const t = await start();

    const response = await t.route.put(
      t.put({ keyMode: "own" }, { "sec-fetch-site": "cross-site" }),
      "acme",
      t.as(await t.person("owner"), "manage_llm_key"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_site_request" });
    expect(await t.stored()).toBeUndefined();
  });

  // #496-T07
  it("answers a body that is not JSON with the usual codes", async () => {
    const t = await start();
    const owner = await t.person("owner");

    const notJson = await t.route.put(
      new Request(`${BASE_URL}/api/w/acme/llm-key-mode`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "own",
      }),
      "acme",
      t.as(owner, "manage_llm_key"),
    );
    const malformed = await t.route.put(
      t.put("{not json"),
      "acme",
      t.as(owner, "manage_llm_key"),
    );

    expect(notJson.status).toBe(415);
    expect(malformed.status).toBe(422);
    expect(await t.stored()).toBeUndefined();
  });

  // #496-T07
  it("is the 404 of a path that does not exist while billing is off, before anything is read", async () => {
    const t = await start({ billingOn: false });

    await expect(
      t.route.put(
        t.put({ keyMode: "own" }),
        "acme",
        t.as(await t.person("owner"), "manage_llm_key"),
      ),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      t.route.get(t.get(), "acme", t.as(await t.person("owner"), "view")),
    ).rejects.toBeInstanceOf(NotFound);
    expect(await t.stored()).toBeUndefined();
  });
});

describe("GET /api/w/:workspace/llm-key-mode", () => {
  // #496-T09
  it("tells every member the choice: our models until the workspace chose", async () => {
    const t = await start();
    const read = async (role: WorkspaceRole) => {
      const response = await t.route.get(
        t.get(),
        "acme",
        t.as(await t.person(role), "view"),
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      return [response.status, await response.json()];
    };

    expect(await read("member")).toEqual([200, { keyMode: "managed" }]);
    await t.route.put(
      t.put({ keyMode: "own" }),
      "acme",
      t.as(await t.person("owner"), "manage_llm_key"),
    );
    expect(await read("member")).toEqual([200, { keyMode: "own" }]);
    expect(await read("admin")).toEqual([200, { keyMode: "own" }]);
  });
});

describe("what the LLM access page reads", () => {
  const serviceOf = (t: Awaited<ReturnType<typeof start>>) => {
    const llm = createWorkspaceLlm({
      db: t.db,
      appSecret: () => APP_SECRET,
      env: () => ({ LLM_MODEL: "vendor/model" }),
    });
    return createLlmKeyModeService({
      db: t.db,
      keysOf: (id) => llm.keyServiceFor(id),
    });
  };

  // #496-T09
  it("is our models and whether a key of the workspace's own is stored", async () => {
    const withKey = await start();
    const withoutKey = await start({ ownKey: false });

    expect(await serviceOf(withKey).choiceOf(withKey.workspaceId)).toEqual({
      keyMode: "managed",
      hasOwnKey: true,
    });
    expect(
      await serviceOf(withoutKey).choiceOf(withoutKey.workspaceId),
    ).toEqual({ keyMode: "managed", hasOwnKey: false });
  });

  // #496-T09
  it("is what the workspace chose", async () => {
    const t = await start();
    await createLlmKeyModeStore(t.db, t.workspaceId).set("own", null);

    expect(await serviceOf(t).choiceOf(t.workspaceId)).toMatchObject({
      keyMode: "own",
    });
  });
});
