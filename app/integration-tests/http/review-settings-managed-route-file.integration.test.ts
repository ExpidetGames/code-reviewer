// SPDX-License-Identifier: Apache-2.0

// The review settings of a workspace on the operator's key through the real route files and the real
// `reviewSettingsServiceFor` (#283): the key mode is read from the entitlements of the workspace in the database, the
// availability of the quality levels from the operator's `managed_model_tiers`, and nothing is passed in by hand. A
// wrong wiring (the key mode, the availability, the hiding decision) fails here and in no unit test.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import {
  closeDatabase,
  getDatabase,
  initializeDatabaseOnStart,
} from "../../src/db/startup.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import {
  createCatalogFixture,
  seedRepositories,
} from "../../src/test-support/review-settings-harness.ts";
import { createTestDirectory } from "../../src/test-support/test-database.ts";
import {
  DELETE,
  GET as GET_PROJECT,
  PUT as PUT_PROJECT,
} from "../../src/app/api/w/[workspace]/repositories/[repositoryId]/project/settings/route.ts";
import {
  GET as GET_GLOBAL,
  PUT as PUT_GLOBAL,
} from "../../src/app/api/w/[workspace]/review-settings/route.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// Counts the reads of the effective entitlements and passes them through.
const entitlementReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/workspaces/effective-entitlements.ts", async (original) => {
  const real =
    await original<
      typeof import("../../src/workspaces/effective-entitlements.ts")
    >();
  return {
    ...real,
    readEffectiveEntitlements: (
      ...args: Parameters<typeof real.readEffectiveEntitlements>
    ) => {
      entitlementReads.count += 1;
      return real.readEffectiveEntitlements(...args);
    },
  };
});
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

// Made-up ids; nothing in the repository names a real model for a tier.
const TIER_IDS = ["wired-vendor/low-diff", "wired-vendor/high-diff"];
const OWN_MODEL = "own-vendor/chosen-model";
const OWN_DYNAMIC = "own-vendor/chosen-dynamic";

function entitlements(
  keyMode: "own" | "managed",
  modelAccess?: EntitlementsData["modelAccess"],
): EntitlementsData {
  return {
    ...(modelAccess === undefined ? {} : { modelAccess }),
    planLabel: "plan",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
  };
}

async function start() {
  await initializeDatabaseOnStart({
    env: { DATABASE_PATH: join(await createTestDirectory(), "app.db") },
  });
  const db = getDatabase();
  const { first } = await seedRepositories(db);
  const workspaceId = await defaultWorkspaceId(db);
  await createProjectsRepository(db, workspaceId).activate(first.id);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      id: "admin-1",
      workspaceId,
      role: "admin",
      githubLogin: "octocat",
    }),
  );
  await createInstanceSettingsRepository(db).set(
    "managed_model_tiers",
    {
      low: { diff: TIER_IDS[0] as string },
      high: { diff: TIER_IDS[1] as string, dynamic: "wired-vendor/high-dyn" },
    },
    null,
  );
  const setKeyMode = (
    keyMode: "own" | "managed",
    modelAccess?: EntitlementsData["modelAccess"],
  ) =>
    createWorkspaceEntitlementsRepository(db, workspaceId).put(
      entitlements(keyMode, modelAccess),
      null,
    );
  const projectPath = `/api/w/default/repositories/${first.id}/project/settings`;
  const globalContext = { params: Promise.resolve({ workspace: "default" }) };
  const projectContext = {
    params: Promise.resolve({ workspace: "default", repositoryId: first.id }),
  };
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`https://app.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    db,
    workspaceId,
    setKeyMode,
    readGlobal: () =>
      GET_GLOBAL(
        request("GET", "/api/w/default/review-settings"),
        globalContext,
      ),
    readProject: () => GET_PROJECT(request("GET", projectPath), projectContext),
    putGlobal: (settings: unknown) =>
      PUT_GLOBAL(
        request("PUT", "/api/w/default/review-settings", { settings }),
        globalContext,
      ),
    putProject: (settings: unknown) =>
      PUT_PROJECT(request("PUT", projectPath, { settings }), projectContext),
    resetProject: () => DELETE(request("DELETE", projectPath), projectContext),
    catalog: createCatalogFixture(db),
  };
}

afterEach(async () => {
  await closeDatabase();
});

describe("the review settings routes of a workspace whose entitlements say managed", () => {
  // #283-T01
  it("answer the level, the availability read from the operator's tiers, and no model", async () => {
    const t = await start();
    await t.setKeyMode("managed");

    const text = await (await t.readProject()).text();
    const globalText = await (await t.readGlobal()).text();

    for (const body of [text, globalText]) {
      expect(body).not.toMatch(/"(model|fallbackModel|dynamicModel)"/);
      for (const id of TIER_IDS) expect(body).not.toContain(id);
      expect(JSON.parse(body)).toMatchObject({
        modelManagedByInstance: true,
        cost: null,
        effective: { modelTier: "medium" },
      });
    }
    // Only `low` has a Diff model and only `high` has both: yes or no per level and kind, from the stored tiers.
    expect(JSON.parse(text).tierAvailability).toEqual({
      low: { diff: true, dynamic: false },
      medium: { diff: false, dynamic: false },
      high: { diff: true, dynamic: true },
    });
  });

  // #283-T04
  it("refuse a model in a write with MODEL_MANAGED_BY_INSTANCE and accept the level", async () => {
    const t = await start();
    await t.setKeyMode("managed");

    const refused = await t.putProject({ model: OWN_MODEL });
    const accepted = await t.putProject({ modelTier: "low" });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "model", code: "MODEL_MANAGED_BY_INSTANCE" }],
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      overrides: { modelTier: "low" },
    });
  });

  // #283-T02
  it("are the ordinary ones, with the model fields, for a workspace on its own key and for one without entitlements", async () => {
    const t = await start();

    const unlimited = await (await t.readProject()).json();
    await t.setKeyMode("own");
    const own = await (await t.readProject()).json();

    for (const body of [unlimited, own])
      expect(body).toMatchObject({
        modelManagedByInstance: false,
        tierAvailability: null,
        effective: { model: expect.any(String) },
        cost: { warn: false },
      });
  });

  // #283-P3
  it("hide the model fields and the estimate as well while the entitlements cannot be read", async () => {
    const t = await start();
    await t.setKeyMode("managed");
    await t.db
      .updateTable("workspace_entitlements")
      .set({ limits: "{not json" })
      .execute();

    const text = await (await t.readProject()).text();
    const refused = await t.putProject({ model: OWN_MODEL });

    expect(text).not.toMatch(/"(model|fallbackModel|dynamicModel)"/);
    expect(JSON.parse(text)).toMatchObject({
      modelManagedByInstance: true,
      cost: null,
    });
    expect(refused.status).toBe(400);
  });

  // #283-P3
  it("keep the models saved on the workspace's own key through a save and a project reset, and give them back", async () => {
    const t = await start();
    await t.setKeyMode("own");
    await t.putGlobal({ model: OWN_MODEL, maxFindings: 4 });
    await t.putProject({ model: OWN_MODEL, dynamicModel: OWN_DYNAMIC });
    await t.setKeyMode("managed");

    await t.putProject({ maxFindings: 7 });
    const reset = await t.resetProject();

    expect(reset.status).toBe(200);
    expect(await reset.text()).not.toContain("own-vendor");
    await t.setKeyMode("own");
    const back = await (await t.readProject()).json();
    expect(back).toMatchObject({
      overrides: { model: OWN_MODEL },
      dynamic: { overrides: { dynamicModel: OWN_DYNAMIC } },
    });
    expect(back.overrides).not.toHaveProperty("maxFindings");
  });
});

// #430: the plan decides which released entries a managed project may pick (`modelAccess`, #428), through the real
// `reviewSettingsServiceFor` and the entitlements in the database. No test hands the check in.
describe("the catalog entries a managed project may pick follow the modelAccess of its entitlements", () => {
  type Choice = { name: string; available: boolean; reason: string | null };

  async function twoEntries() {
    const t = await start();
    const a = await t.catalog.entry({ name: "Alpha" });
    const b = await t.catalog.entry({ name: "Bravo" });
    const picker = async () => {
      const view = await (await t.readProject()).json();
      const choices: Choice[] = view.catalogChoices.diff;
      return choices.map((c) => [c.name, c.available, c.reason]);
    };
    return { ...t, a, b, picker };
  }
  const OPEN = [
    ["Alpha", true, null],
    ["Bravo", true, null],
  ];
  const LOCKED = (name: string) => [name, false, "CATALOG_ENTRY_NOT_ALLOWED"];

  // #430-T07
  it("allow only the entries of an explicit list: the others are refused and listed locked", async () => {
    const t = await twoEntries();
    await t.setKeyMode("managed", { catalogEntries: [t.a.id] });

    const refused = await t.putProject({ catalogEntryDiff: t.b.id });
    const accepted = await t.putProject({ catalogEntryDiff: t.a.id });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "catalogEntryDiff", code: "CATALOG_ENTRY_NOT_ALLOWED" },
      ],
    });
    expect(accepted.status).toBe(200);
    expect(await t.picker()).toEqual([["Alpha", true, null], LOCKED("Bravo")]);
  });

  // #430-T07
  it("allow nothing for an empty list", async () => {
    const t = await twoEntries();
    await t.setKeyMode("managed", { catalogEntries: [] });

    const refused = await t.putProject({ catalogEntryDiff: t.a.id });

    expect(refused.status).toBe(400);
    expect(await t.picker()).toEqual([LOCKED("Alpha"), LOCKED("Bravo")]);
  });

  // #430-T07
  it.each([
    ["null", { catalogEntries: null }],
    ["absent", undefined],
  ] as const)("allow every released entry for %s", async (_, modelAccess) => {
    const t = await twoEntries();
    await t.setKeyMode("managed", modelAccess);

    const accepted = await t.putProject({ catalogEntryDiff: t.b.id });

    expect(accepted.status).toBe(200);
    expect(await t.picker()).toEqual(OPEN);
  });

  // #430-T07
  it("allow nothing while the entitlements cannot be read", async () => {
    const t = await twoEntries();
    await t.setKeyMode("managed", { catalogEntries: null });
    await t.db
      .updateTable("workspace_entitlements")
      .set({ limits: "{not json" })
      .execute();

    const refused = await t.putProject({ catalogEntryDiff: t.a.id });

    expect(refused.status).toBe(400);
    expect(await t.picker()).toEqual([LOCKED("Alpha"), LOCKED("Bravo")]);
  });

  // #430-T07
  it("read the entitlements once for one request, however many entries and kinds it lists", async () => {
    const t = await twoEntries();
    await t.catalog.entry({ name: "Charlie" });
    await t.catalog.entry({ name: "Delta", kinds: ["dynamic"] });
    await t.setKeyMode("managed", { catalogEntries: null });
    entitlementReads.count = 0;

    const read = await t.readProject();
    const readsOfRead = entitlementReads.count;
    entitlementReads.count = 0;
    const written = await t.putProject({ catalogEntryDiff: t.a.id });

    expect(read.status).toBe(200);
    expect(readsOfRead).toBe(1);
    expect(written.status).toBe(200);
    expect(entitlementReads.count).toBe(1);
  });
});
