// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type {
  ModelCapabilityChecker,
  ModelCapabilityResult,
} from "../llm/model-capabilities.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import { insertUser } from "../test-support/users.ts";
import { createCatalogService } from "./service.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const SUPPORTED: ModelCapabilityResult = {
  outcome: "supported",
  capabilities: {
    tools: true,
    toolChoice: true,
    toolChoiceRequired: true,
    responseFormat: true,
    structuredOutputs: true,
    maxCompletionTokens: 8192,
    smallestCompletionTokens: 8192,
    contextLength: 200_000,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
  },
};
const NO_TOOLS: ModelCapabilityResult = {
  outcome: "unsupported",
  capabilities: { ...SUPPORTED.capabilities!, toolChoice: false },
};

const open = async (): Promise<Kysely<Database>> =>
  (await createTestDatabase()).db;

let counter = 0;

const FAST = {
  name: "Fast",
  description: "Quick reviews that point out the obvious problems.",
  provider: "openrouter",
  modelId: "acme/quick-1",
  kinds: ["diff"],
};

describe("the model catalog service", () => {
  async function start(
    answer: (modelId: string) => ModelCapabilityResult = () => SUPPORTED,
  ) {
    const db = await open();
    const catalog = createCatalogRepository(db);
    const settings = createInstanceSettingsRepository(db);
    const asked: string[] = [];
    const askedProviders: Array<string | undefined> = [];
    const lines: string[] = [];
    const modelCapabilities: ModelCapabilityChecker = {
      check: async (modelId, options) => {
        asked.push(modelId);
        askedProviders.push(options?.provider);
        return answer(modelId);
      },
    };
    const service = createCatalogService({
      catalog,
      settings,
      modelCapabilities,
      logger: { info: (line) => lines.push(line) },
    });
    return { db, catalog, settings, service, asked, askedProviders, lines };
  }

  async function created(
    service: Awaited<ReturnType<typeof start>>["service"],
    input: Record<string, unknown> = FAST,
  ) {
    const result = await service.create(input, null);
    if (!result.ok) throw new Error(`create refused: ${result.code}`);
    return result.entry;
  }

  // #425-T01
  it("is empty on an instance that never used it, with no default", async () => {
    const { service, settings } = await start();

    expect(await service.list()).toEqual([]);
    expect(await service.memberEntries()).toEqual([]);
    expect(await service.allCatalogModelIds()).toEqual([]);
    expect(await service.defaults()).toEqual({ diff: null, dynamic: null });
    expect(await settings.get("catalog_defaults")).toBeUndefined();
  });

  // #425-T01
  it("creates a draft, lists it and updates it, with the same opaque id throughout", async () => {
    const { service, asked } = await start();

    const result = await service.create({ ...FAST, sortOrder: 3 }, null);

    expect(result).toMatchObject({
      ok: true,
      entry: { name: "Fast", status: "draft", kinds: ["diff"], sortOrder: 3 },
    });
    if (!result.ok) return;
    const id = result.entry.id;
    expect(id).toMatch(/^mce_[0-9a-f]{32}$/);
    const updated = await service.update(
      id,
      { name: "Quicker", description: null, sortOrder: 1 },
      null,
    );
    expect(updated).toMatchObject({
      ok: true,
      entry: { id, name: "Quicker", description: null, sortOrder: 1 },
      modelChange: null,
    });
    expect((await service.list()).map((entry) => entry.id)).toEqual([id]);
    expect(await service.get(id)).toMatchObject({ name: "Quicker" });
    // A draft is not checked against the provider until it is released.
    expect(asked).toEqual([]);
  });

  // #425-T01
  it("refuses what is not a well-formed entry, with a stable code each", async () => {
    const { service } = await start();
    const code = async (input: unknown) => {
      const result = await service.create(input, null);
      return result.ok ? "ok" : result.code;
    };

    expect(await code("nope")).toBe("request_invalid");
    expect(await code({ ...FAST, name: " Fast" })).toBe("name_invalid");
    expect(await code({ ...FAST, description: "Cheap" })).toBe(
      "description_invalid",
    );
    expect(await code({ ...FAST, provider: "nowhere" })).toBe(
      "PROVIDER_UNKNOWN",
    );
    expect(await code({ ...FAST, modelId: "has space" })).toBe(
      "model_id_invalid",
    );
    expect(await code({ ...FAST, kinds: [] })).toBe("kinds_invalid");
    expect(await code({ ...FAST, kinds: ["diff", "audit"] })).toBe(
      "kinds_invalid",
    );
    expect(await code({ ...FAST, sortOrder: 1.5 })).toBe("request_invalid");
    expect(await service.list()).toEqual([]);
  });

  // #425-T02
  it("refuses a second entry whose name differs only in case: catalog_name_taken", async () => {
    const { service } = await start();
    await created(service, { ...FAST, name: "Deep" });

    const second = await service.create({ ...FAST, name: "DEEP" }, null);
    const other = await created(service, { ...FAST, name: "Other" });
    const renamed = await service.update(other.id, { name: "deep" }, null);

    expect(second).toEqual({ ok: false, code: "catalog_name_taken" });
    expect(renamed).toEqual({ ok: false, code: "catalog_name_taken" });
    expect((await service.list()).map((entry) => entry.name)).toEqual([
      "Deep",
      "Other",
    ]);
  });

  // #425-T05
  it("refuses a name that gives the model away, on create and on every change that could", async () => {
    const { service } = await start();

    expect(
      await service.create({ ...FAST, name: "My quick-1" }, null),
    ).toMatchObject({ ok: false, code: "name_reveals_model" });
    expect(
      await service.create({ ...FAST, name: "OpenRouter Fast" }, null),
    ).toMatchObject({ ok: false, code: "name_reveals_model" });
    const entry = await created(service, { ...FAST, name: "Swift" });
    expect(
      await service.update(entry.id, { modelId: "acme/swift" }, null),
    ).toMatchObject({ ok: false, code: "name_reveals_model" });
    expect(
      await service.update(entry.id, { name: "acme/quick-1" }, null),
    ).toMatchObject({ ok: false, code: "name_reveals_model" });
    expect((await service.get(entry.id))?.modelId).toBe("acme/quick-1");
  });

  // #425-T06
  it("refuses a description that speaks of a vendor, a price or a model, on create and on update", async () => {
    const { service } = await start();
    const entry = await created(service);

    expect(
      await service.update(
        entry.id,
        { description: "Runs on a Claude model" },
        null,
      ),
    ).toMatchObject({ ok: false, code: "description_invalid" });
    expect((await service.get(entry.id))?.description).toBe(FAST.description);
  });

  // #425-T06
  it("refuses a description that names the entry's own model or vendor, on create and on every change that could", async () => {
    const { service } = await start();

    expect(
      await service.create(
        { ...FAST, description: "Runs acme-labs for quick feedback" },
        null,
      ),
    ).toMatchObject({
      ok: false,
      code: "description_invalid",
      field: "description",
    });
    expect(
      await service.create(
        {
          ...FAST,
          modelId: "x-ai/grok-4-fast:free",
          description: "Powered by Grok 4",
        },
        null,
      ),
    ).toMatchObject({ ok: false, code: "description_invalid" });
    const entry = await created(service, {
      ...FAST,
      description: "Obvious problems, found fast.",
    });
    // The description stays as it is; the model it is checked against changes.
    expect(
      await service.update(entry.id, { modelId: "acme/obvious-1" }, null),
    ).toMatchObject({ ok: false, code: "description_invalid" });
    expect(
      await service.update(entry.id, { description: "Acme says so" }, null),
    ).toMatchObject({ ok: false, code: "description_invalid" });
    expect((await service.get(entry.id))?.modelId).toBe("acme/quick-1");
  });

  // #425-T03
  it("moves from draft to released to retired and to released again, and releases only what it checked", async () => {
    const { service, asked, askedProviders } = await start();
    const entry = await created(service);

    const released = await service.release(entry.id, null);
    expect(released).toMatchObject({
      ok: true,
      entry: { status: "released" },
    });
    expect(asked).toEqual(["acme/quick-1"]);
    expect(await service.retire(entry.id, null)).toMatchObject({
      ok: true,
      entry: { status: "retired" },
    });
    expect(await service.release(entry.id, null)).toMatchObject({
      ok: true,
      entry: { status: "released" },
    });
    expect(asked).toEqual(["acme/quick-1", "acme/quick-1"]);
    // The check is asked about the provider of the entry (#423), not the default one.
    expect(askedProviders).toEqual(["openrouter", "openrouter"]);
  });

  // #425-T03
  it("refuses a transition the rules do not allow", async () => {
    const { service } = await start();
    const entry = await created(service);

    expect(await service.retire(entry.id, null)).toEqual({
      ok: false,
      code: "catalog_transition_invalid",
    });
    await service.release(entry.id, null);
    expect(await service.release(entry.id, null)).toEqual({
      ok: false,
      code: "catalog_transition_invalid",
    });
    expect(await service.release("mce_missing", null)).toEqual({
      ok: false,
      code: "CATALOG_ENTRY_UNKNOWN",
    });
    expect((await service.get(entry.id))?.status).toBe("released");
  });

  // #425-T03
  it("deletes a draft and never a released or retired entry", async () => {
    const { service } = await start();
    const draft = await created(service, { ...FAST, name: "Draft" });
    const live = await created(service, { ...FAST, name: "Live" });
    await service.release(live.id, null);

    expect(await service.remove(draft.id)).toEqual({ ok: true });
    expect(await service.remove(live.id)).toEqual({
      ok: false,
      code: "catalog_entry_not_draft",
    });
    await service.retire(live.id, null);
    expect(await service.remove(live.id)).toEqual({
      ok: false,
      code: "catalog_entry_not_draft",
    });
    expect(await service.remove("mce_missing")).toEqual({
      ok: false,
      code: "CATALOG_ENTRY_UNKNOWN",
    });
    expect((await service.list()).map((entry) => entry.id)).toEqual([live.id]);
  });

  // #425-T04
  it("refuses to release a Dynamic entry whose model has no tool support, is unknown or cannot be verified", async () => {
    const outcomes: Record<string, ModelCapabilityResult> = {
      "acme/no-tools": NO_TOOLS,
      "acme/typo": { outcome: "unknown_model" },
      "acme/unreachable": { outcome: "unverifiable" },
    };
    const { service } = await start(
      (modelId) => outcomes[modelId] ?? SUPPORTED,
    );
    const release = async (modelId: string, kinds: string[]) => {
      const entry = await created(service, {
        ...FAST,
        name: `Entry ${counter++}`,
        modelId,
        kinds,
      });
      const result = await service.release(entry.id, null);
      return [
        result.ok ? "ok" : result.code,
        (await service.get(entry.id))?.status,
      ];
    };

    expect(await release("acme/no-tools", ["dynamic"])).toEqual([
      "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
      "draft",
    ]);
    expect(await release("acme/typo", ["dynamic"])).toEqual([
      "DYNAMIC_MODEL_UNKNOWN",
      "draft",
    ]);
    expect(await release("acme/unreachable", ["dynamic"])).toEqual([
      "DYNAMIC_MODEL_UNVERIFIED",
      "draft",
    ]);
    expect(await release("acme/typo", ["diff"])).toEqual([
      "MODEL_UNKNOWN",
      "draft",
    ]);
    // An entry that serves both kinds is held to the stricter one.
    expect(await release("acme/no-tools", ["diff", "dynamic"])).toEqual([
      "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
      "draft",
    ]);
  });

  // #425-T04
  it("releases a Diff entry whose model cannot be verified or has no tool support", async () => {
    const outcomes: Record<string, ModelCapabilityResult> = {
      "acme/no-tools": NO_TOOLS,
      "acme/unreachable": { outcome: "unverifiable" },
    };
    const { service } = await start(
      (modelId) => outcomes[modelId] ?? SUPPORTED,
    );

    for (const modelId of ["acme/unreachable", "acme/no-tools"]) {
      const entry = await created(service, {
        ...FAST,
        name: `Entry ${counter++}`,
        modelId,
      });
      expect(await service.release(entry.id, null)).toMatchObject({
        ok: true,
      });
    }
  });

  // #425-T08
  it("accepts defaults that name a released entry which serves the kind", async () => {
    const { service, settings } = await start();
    const both = await created(service, {
      ...FAST,
      name: "Both",
      kinds: ["diff", "dynamic"],
    });
    await service.release(both.id, null);

    const saved = await service.setDefaults(
      { diff: both.id, dynamic: both.id },
      null,
    );

    expect(saved).toEqual({
      ok: true,
      defaults: { diff: both.id, dynamic: both.id },
    });
    expect(await service.defaults()).toEqual({
      diff: both.id,
      dynamic: both.id,
    });
    expect(await settings.get("catalog_defaults")).toEqual({
      diff: both.id,
      dynamic: both.id,
    });
    expect(
      await service.setDefaults({ diff: null, dynamic: null }, null),
    ).toMatchObject({ ok: true });
    expect(await service.defaults()).toEqual({ diff: null, dynamic: null });
  });

  // #425-T08
  it("refuses a default that names a draft, a retired, a wrong-kind or an unknown entry, and stores nothing", async () => {
    const { service, settings } = await start();
    const draft = await created(service, { ...FAST, name: "Draft" });
    const old = await created(service, { ...FAST, name: "Old" });
    await service.release(old.id, null);
    await service.retire(old.id, null);
    const diffOnly = await created(service, { ...FAST, name: "Diff only" });
    await service.release(diffOnly.id, null);

    const refuse = async (input: unknown) => {
      const result = await service.setDefaults(input, null);
      return result.ok ? "ok" : [result.code, result.field];
    };
    expect(await refuse({ diff: draft.id, dynamic: null })).toEqual([
      "CATALOG_ENTRY_NOT_RELEASED",
      "diff",
    ]);
    expect(await refuse({ diff: old.id, dynamic: null })).toEqual([
      "CATALOG_ENTRY_NOT_RELEASED",
      "diff",
    ]);
    expect(await refuse({ diff: null, dynamic: diffOnly.id })).toEqual([
      "CATALOG_ENTRY_KIND_MISMATCH",
      "dynamic",
    ]);
    expect(await refuse({ diff: "mce_missing", dynamic: null })).toEqual([
      "CATALOG_ENTRY_UNKNOWN",
      "diff",
    ]);
    expect(await refuse({ diff: 7, dynamic: null })).toEqual([
      "request_invalid",
      "diff",
    ]);
    expect(await refuse({ diff: null })).toEqual([
      "request_invalid",
      "dynamic",
    ]);
    expect(await refuse(null)).toEqual(["request_invalid", undefined]);
    expect(await settings.get("catalog_defaults")).toBeUndefined();
  });

  // #425-T08
  it("does not retire or narrow the entry that is a default, and reads a default that went stale as none", async () => {
    const { service, settings, catalog } = await start();
    const entry = await created(service, {
      ...FAST,
      kinds: ["diff", "dynamic"],
    });
    await service.release(entry.id, null);
    await service.setDefaults({ diff: entry.id, dynamic: entry.id }, null);

    expect(await service.retire(entry.id, null)).toMatchObject({
      ok: false,
      code: "catalog_entry_is_default",
    });
    expect(await service.update(entry.id, { kinds: ["diff"] }, null)).toEqual({
      ok: false,
      code: "catalog_entry_is_default",
      field: "dynamic",
    });
    await service.setDefaults({ diff: entry.id, dynamic: null }, null);
    expect(
      await service.update(entry.id, { kinds: ["diff"] }, null),
    ).toMatchObject({ ok: true });
    // Damage behind the service's back: the default reads as none, never as an entry that cannot serve.
    const entryRow = await catalog.get(entry.id);
    await catalog.setStatus(
      entry.id,
      "released",
      "retired",
      null,
      entryRow?.updatedAt,
    );
    expect(await service.defaults()).toEqual({ diff: null, dynamic: null });
    await settings.set("catalog_defaults", { diff: 5 } as never, null);
    expect(await service.defaults()).toEqual({ diff: null, dynamic: null });
  });

  // #425-T09
  it("re-checks the model changed behind a released entry, writes an audit line and returns the project count", async () => {
    const database = await open();
    const fixture = await createJobQueueFixture({ database });
    await insertUser(database, { id: "user-9" });
    const lines: string[] = [];
    const asked: string[] = [];
    const service = createCatalogService({
      catalog: createCatalogRepository(database),
      settings: createInstanceSettingsRepository(database),
      modelCapabilities: {
        check: async (modelId) => {
          asked.push(modelId);
          return modelId === "acme/no-tools" ? NO_TOOLS : SUPPORTED;
        },
      },
      logger: { info: (line) => lines.push(line) },
    });
    const entry = await created(service, { ...FAST, kinds: ["dynamic"] });
    await service.release(entry.id, null);
    await database
      .insertInto("projects")
      .values({
        id: "p1",
        repository_id: fixture.repositoryId,
        active: 1,
        settings: JSON.stringify({ catalogEntryDynamic: entry.id }),
        created_at: "2026-10-17T10:00:00.000Z",
        updated_at: "2026-10-17T10:00:00.000Z",
      })
      .execute();
    asked.length = 0;

    expect(await service.usedByProjects(entry.id)).toBe(1);
    const refused = await service.update(
      entry.id,
      { modelId: "acme/no-tools" },
      "user-9",
      { confirmModelChange: true },
    );
    expect(refused).toEqual({
      ok: false,
      code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
    });
    expect((await service.get(entry.id))?.modelId).toBe("acme/quick-1");
    expect(lines).toEqual([]);

    const changed = await service.update(
      entry.id,
      { modelId: "acme/better-2" },
      "user-9",
      { confirmModelChange: true },
    );

    expect(changed).toMatchObject({
      ok: true,
      entry: {
        modelId: "acme/better-2",
        status: "released",
        updatedBy: "user-9",
      },
      modelChange: { projects: 1 },
    });
    expect(asked).toEqual(["acme/no-tools", "acme/better-2"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(entry.id);
    expect(lines[0]).toContain("user-9");
    expect(lines[0]).toContain("acme/quick-1");
    expect(lines[0]).toContain("acme/better-2");
    expect(lines[0]).toContain("1 project");
    // A change that leaves the model and the provider alone is no model change.
    const renamed = await service.update(
      entry.id,
      { name: "Renamed" },
      "user-9",
    );
    expect(renamed).toMatchObject({ ok: true, modelChange: null });
    expect(lines).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });

  // #429-T09
  it("decides on the entry it writes: the model behind a released entry changes only with the confirmation, which is refused with the count and writes nothing", async () => {
    const { service, db, asked, lines } = await start();
    const fixture = await createJobQueueFixture({ database: db });
    const entry = await created(service);
    await service.release(entry.id, null);
    await db
      .insertInto("projects")
      .values({
        id: "p1",
        repository_id: fixture.repositoryId,
        active: 1,
        settings: JSON.stringify({ catalogEntryDiff: entry.id }),
        created_at: "2026-10-17T10:00:00.000Z",
        updated_at: "2026-10-17T10:00:00.000Z",
      })
      .execute();
    asked.length = 0;

    const unconfirmed = await service.update(
      entry.id,
      { modelId: "acme/better-2" },
      null,
    );
    const falsy = await service.update(
      entry.id,
      { modelId: "acme/better-2" },
      null,
      { confirmModelChange: false },
    );

    expect(unconfirmed).toEqual({
      ok: false,
      code: "model_change_not_confirmed",
      projects: 1,
    });
    expect(falsy).toEqual(unconfirmed);
    expect((await service.get(entry.id))?.modelId).toBe("acme/quick-1");
    expect(asked).toEqual([]);
    expect(lines).toEqual([]);
    // A change that leaves the model alone needs none.
    expect(
      await service.update(entry.id, { name: "Renamed" }, null),
    ).toMatchObject({ ok: true, modelChange: null });
  });

  // #425-T09
  it("changes the model of a draft or a retired entry without a check or an audit line", async () => {
    const { service, asked, lines } = await start();
    const entry = await created(service);

    expect(
      await service.update(entry.id, { modelId: "acme/other" }, null),
    ).toMatchObject({
      ok: true,
      modelChange: null,
    });
    expect(asked).toEqual([]);
    expect(lines).toEqual([]);
  });

  // #425-T07
  it("hands a member the released and retired entries by name, never the model", async () => {
    const { service } = await start();
    const entry = await created(service, {
      ...FAST,
      modelId: "acme-labs/secret-model",
    });
    await created(service, {
      ...FAST,
      name: "Hidden one",
      modelId: "sentinel/draft",
    });
    await service.release(entry.id, null);

    const members = await service.memberEntries();

    expect(members).toEqual([
      {
        id: entry.id,
        name: "Fast",
        description: FAST.description,
        providerLabel: "Acme Labs",
        kinds: ["diff"],
        status: "released",
        sortOrder: 0,
      },
    ]);
    expect(JSON.stringify(members)).not.toMatch(
      /sentinel|openrouter|secret-model|acme-labs/,
    );
    expect((await service.allCatalogModelIds()).sort()).toEqual([
      "acme-labs/secret-model",
      "sentinel/draft",
    ]);
  });
});
