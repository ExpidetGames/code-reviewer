// SPDX-License-Identifier: LicenseRef-Proprietary

// The provider and the catalog entry a project selects (#430, ADR 0005, 2.7), against a real database and a real
// model catalog: what is stored beside what, what a workspace on its own key and one on the operator's key may write,
// the checks of a catalog entry, and what the views show (never a model or a provider to a managed workspace).
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  createCatalogFixture,
  setupReviewSettings,
} from "../test-support/review-settings-harness.ts";
import { ReviewSettingsError } from "./errors.ts";
import { createReviewSettingsRouteHandlers } from "./http.ts";
import type { ReviewSettingIssue } from "./validate.ts";

async function issuesOf(promise: Promise<unknown>): Promise<{
  code: string;
  issues: readonly ReviewSettingIssue[];
}> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReviewSettingsError)
      return { code: error.code, issues: error.issues };
    throw error;
  }
  throw new Error("expected the call to be refused");
}

/** A workspace on its own key or on the operator's, with a real catalog behind it. */
async function start(options: { managed: boolean }) {
  const { db } = await createTestDatabase();
  const catalog = createCatalogFixture(db);
  const app = await setupReviewSettings(db, {
    operatorsModels: options.managed,
    catalog: catalog.source,
  });
  await app.projects.activate(app.first.id);
  return {
    ...app,
    catalog,
    /** What the project row stores, as the repository reads it. */
    async stored() {
      return (await app.projects.get(app.first.id))?.settings;
    },
  };
}

/** Every key name in a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...keysOf(entry),
  ]);
}

describe("a save keeps what it does not set", () => {
  // #430-T04
  it("keeps the fields of the other kind: Diff and Dynamic provider and model are saved apart", async () => {
    const app = await start({ managed: false });

    await app.service.updateProjectSettings(app.first.id, {
      provider: "openrouter",
      model: "vendor/diff-model",
    });
    await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: "openrouter",
      dynamicModel: "vendor/dynamic-model",
    });
    const afterDynamicSave = await app.stored();
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 3 });

    expect(afterDynamicSave).toMatchObject({
      provider: "openrouter",
      model: "vendor/diff-model",
      dynamicProvider: "openrouter",
      dynamicModel: "vendor/dynamic-model",
    });
    // A save of the Diff group replaces that group (a field left out is inherited again) but never the Dynamic fields.
    expect(await app.stored()).toEqual({
      maxFindings: 3,
      dynamicProvider: "openrouter",
      dynamicModel: "vendor/dynamic-model",
    });
  });

  // #430-T04
  it("keeps the catalog entry of the other kind when one kind's entry is saved", async () => {
    const app = await start({ managed: true });
    const diff = await app.catalog.entry({ kinds: ["diff"] });
    const dynamic = await app.catalog.entry({ kinds: ["dynamic"] });

    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDiff: diff.id,
    });
    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDynamic: dynamic.id,
    });

    expect(await app.stored()).toEqual({
      catalogEntryDiff: diff.id,
      catalogEntryDynamic: dynamic.id,
    });
  });

  // #430-T04
  it("keeps the family of the other key mode: the own models while managed, the catalog entries while on the own key", async () => {
    const app = await start({ managed: true });
    const entry = await app.catalog.entry();
    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDiff: entry.id,
    });

    // The workspace goes to its own key and saves its models.
    app.setOperatorsModels(false);
    await app.service.updateProjectSettings(app.first.id, {
      provider: "openrouter",
      model: "vendor/own-diff",
      dynamicProvider: "openrouter",
      dynamicModel: "vendor/own-dynamic",
    });
    expect(await app.stored()).toMatchObject({
      catalogEntryDiff: entry.id,
      model: "vendor/own-diff",
    });

    // And back to the operator's key: a save there touches neither the models nor the provider.
    app.setOperatorsModels(true);
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 4 });
    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDynamic: entry.id,
    });

    expect(await app.stored()).toEqual({
      maxFindings: 4,
      provider: "openrouter",
      model: "vendor/own-diff",
      dynamicProvider: "openrouter",
      dynamicModel: "vendor/own-dynamic",
      catalogEntryDiff: entry.id,
      catalogEntryDynamic: entry.id,
    });
  });
});

describe("a workspace on the operator's key", () => {
  // #430-T05
  it.each([
    ["model", "vendor/chosen"],
    ["fallbackModel", "vendor/chosen"],
    ["provider", "openrouter"],
    ["dynamicModel", "vendor/chosen"],
    ["dynamicProvider", "openrouter"],
  ])(
    "may not write %s to a project: MODEL_MANAGED_BY_INSTANCE, nothing stored",
    async (field, value) => {
      const app = await start({ managed: true });

      const refused = await issuesOf(
        app.service.updateProjectSettings(app.first.id, { [field]: value }),
      );

      expect(refused).toEqual({
        code: "REVIEW_SETTINGS_INVALID",
        issues: [{ field, code: "MODEL_MANAGED_BY_INSTANCE" }],
      });
      expect(await app.stored()).toEqual({});
    },
  );

  // #430-T05
  it("may not write the provider to the workspace defaults either, and nothing is stored", async () => {
    const app = await start({ managed: true });

    const refused = await issuesOf(
      app.service.updateGlobalSettings({ provider: "openrouter" }, "octocat"),
    );

    expect(refused.issues).toEqual([
      { field: "provider", code: "MODEL_MANAGED_BY_INSTANCE" },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #430-T07
  it("selects a released entry that serves the kind and that the plan allows", async () => {
    const app = await start({ managed: true });
    const both = await app.catalog.entry({ kinds: ["diff", "dynamic"] });
    const dynamicOnly = await app.catalog.entry({ kinds: ["dynamic"] });

    const view = await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDiff: both.id,
      catalogEntryDynamic: dynamicOnly.id,
    });

    expect(await app.stored()).toEqual({
      catalogEntryDiff: both.id,
      catalogEntryDynamic: dynamicOnly.id,
    });
    expect(view.catalogSelection).toEqual({
      diff: both.id,
      dynamic: dynamicOnly.id,
    });
  });

  // #430-T07
  it.each([
    ["an entry that does not exist", "CATALOG_ENTRY_UNKNOWN"],
    ["a model name instead of an entry id", "CATALOG_ENTRY_UNKNOWN"],
    ["a draft", "CATALOG_ENTRY_NOT_RELEASED"],
    ["a retired entry", "CATALOG_ENTRY_NOT_RELEASED"],
    ["an entry of the other kind", "CATALOG_ENTRY_KIND_MISMATCH"],
    ["an entry the plan does not allow", "CATALOG_ENTRY_NOT_ALLOWED"],
  ] as const)("refuses %s with %s and stores nothing", async (what, code) => {
    const app = await start({ managed: true });
    const ids: Record<string, string> = {
      "an entry that does not exist": "mce_0123456789abcdef0123456789abcdef",
      "a model name instead of an entry id": "claude-sonnet-5-5",
      "a draft": (await app.catalog.entry({ status: "draft" })).id,
      "a retired entry": (await app.catalog.entry({ status: "retired" })).id,
      "an entry of the other kind": (
        await app.catalog.entry({ kinds: ["dynamic"] })
      ).id,
    };
    const forbidden = await app.catalog.entry();
    app.catalog.forbid(forbidden.id);
    ids["an entry the plan does not allow"] = forbidden.id;

    const refused = await issuesOf(
      app.service.updateProjectSettings(app.first.id, {
        catalogEntryDiff: ids[what],
      }),
    );

    expect(refused).toEqual({
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "catalogEntryDiff", code }],
    });
    expect(await app.stored()).toEqual({});
  });

  // #430-T07
  it("names every kind whose entry is refused, each with its own code", async () => {
    const app = await start({ managed: true });
    const diffOnly = await app.catalog.entry({ kinds: ["diff"] });

    const refused = await issuesOf(
      app.service.updateProjectSettings(app.first.id, {
        catalogEntryDiff: "mce_0123456789abcdef0123456789abcdef",
        catalogEntryDynamic: diffOnly.id,
      }),
    );

    expect(refused.issues).toEqual([
      { field: "catalogEntryDiff", code: "CATALOG_ENTRY_UNKNOWN" },
      { field: "catalogEntryDynamic", code: "CATALOG_ENTRY_KIND_MISMATCH" },
    ]);
    expect(await app.stored()).toEqual({});
  });

  // #430-T07
  it("clears a selection with null without asking the catalog", async () => {
    const app = await start({ managed: true });
    const entry = await app.catalog.entry();
    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDiff: entry.id,
    });
    app.catalog.reads.finds = 0;

    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDiff: null,
    });

    expect(await app.stored()).toEqual({});
    expect(app.catalog.reads.finds).toBe(0);
  });

  // #434-T03
  it("no longer accepts the old quality level beside a catalog entry: the request is refused whole", async () => {
    const app = await start({ managed: true });
    const entry = await app.catalog.entry();
    const legacy = ["model", "Tier"].join("");

    await expect(
      app.service.updateProjectSettings(app.first.id, {
        [legacy]: "high",
        catalogEntryDiff: entry.id,
      }),
    ).rejects.toMatchObject({
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: legacy, code: "UNKNOWN_FIELD" }],
    });
    expect(await app.stored()).toEqual({});
  });
});

describe("a workspace on its own key", () => {
  // #430-T06
  it("may not write a catalog entry: CATALOG_ENTRY_OWN_KEY_MODE, nothing stored, the catalog not read", async () => {
    const app = await start({ managed: false });
    const entry = await app.catalog.entry();

    const refused = await issuesOf(
      app.service.updateProjectSettings(app.first.id, {
        catalogEntryDiff: entry.id,
        catalogEntryDynamic: "mce_unknown",
      }),
    );

    expect(refused).toEqual({
      code: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "catalogEntryDiff", code: "CATALOG_ENTRY_OWN_KEY_MODE" },
        { field: "catalogEntryDynamic", code: "CATALOG_ENTRY_OWN_KEY_MODE" },
      ],
    });
    expect(await app.stored()).toEqual({});
    expect(app.catalog.reads.count).toBe(0);
  });

  // #430-T06
  it("may clear an entry stored earlier with null", async () => {
    const app = await start({ managed: true });
    const entry = await app.catalog.entry();
    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDiff: entry.id,
    });
    app.setOperatorsModels(false);

    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDiff: null,
    });

    expect(await app.stored()).toEqual({});
  });

  // #430-T06
  it("reads no catalog row for a view, a save or a reset", async () => {
    const app = await start({ managed: false });

    await app.service.getProjectSettings(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      provider: "openrouter",
      model: "vendor/own",
    });
    await app.service.resetProjectSettings(app.first.id);

    expect(app.catalog.reads.count).toBe(0);
  });

  // #430-T02
  it("takes the provider from the project, else the workspace default, else the default provider", async () => {
    const app = await start({ managed: false });

    const none = await app.service.getProjectSettings(app.first.id);
    await app.service.updateGlobalSettings({ provider: "openrouter" }, "a");
    const global = await app.service.getProjectSettings(app.first.id);
    const saved = await app.service.updateProjectSettings(app.first.id, {
      provider: "openrouter",
      dynamicProvider: "openrouter",
    });

    expect(none.effective.provider).toBe("openrouter");
    expect(none.sources.provider).toBe("built_in");
    expect(global.sources.provider).toBe("global");
    expect(saved.sources.provider).toBe("project");
    expect(saved.dynamic.effective.dynamicProvider).toBe("openrouter");
    expect(saved.dynamic.sources.dynamicProvider).toBe("project");
  });

  // #430-T03
  it("reads settings stored before the provider existed as the default provider", async () => {
    const app = await start({ managed: false });
    await app.projects.updateSettingsWith(app.first.id, () => ({
      model: "qwen/qwen3-coder",
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    }));
    await app.appSettings.set("review_defaults", { maxFindings: 9 }, "a");

    const view = await app.service.getProjectSettings(app.first.id);
    const resolved = await app.service.resolveForRepository(app.first.id);

    expect(view.effective.provider).toBe("openrouter");
    expect(view.effective.model).toBe("qwen/qwen3-coder");
    expect(view.dynamic.effective.dynamicProvider).toBe("openrouter");
    expect(resolved?.settings.provider).toBe("openrouter");
    expect(resolved?.dynamic.dynamicProvider).toBe("openrouter");
    expect(resolved?.dynamic.catalogEntryDiff).toBeNull();
  });

  // #430-T03
  it("falls back to the default provider when the stored one is no longer in the registry", async () => {
    const app = await start({ managed: false });
    await app.projects.updateSettingsWith(app.first.id, () => ({
      provider: "removed_provider",
      dynamicProvider: "removed_provider",
    }));

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.effective.provider).toBe("openrouter");
    expect(view.sources.provider).toBe("built_in");
    expect(view.dynamic.effective.dynamicProvider).toBe("openrouter");
  });
});

describe("the views of a workspace on the operator's key", () => {
  const SENTINELS = [
    "sentinel/own-model",
    "sentinel/own-fallback",
    "sentinel/own-dynamic",
    "sentinel/global-model",
    "sentinel/entry-model",
    "openrouter",
  ];

  async function seeded() {
    const app = await start({ managed: true });
    const entry = await app.catalog.entry({
      name: "Alpha",
      modelId: "sentinel/entry-model-a",
    });
    await app.projects.updateSettingsWith(app.first.id, () => ({
      provider: "openrouter",
      model: "sentinel/own-model",
      fallbackModel: "sentinel/own-fallback",
      dynamicModel: "sentinel/own-dynamic",
      dynamicProvider: "openrouter",
      reviewKind: "dynamic",
      catalogEntryDiff: entry.id,
    }));
    await app.appSettings.set(
      "review_defaults",
      { provider: "openrouter", model: "sentinel/global-model" },
      "a",
    );
    return { app, entry };
  }

  // #430-T08
  it("carry no model, no provider and no Dynamic model or provider, in any view", async () => {
    const { app, entry } = await seeded();
    const forbiddenKeys = [
      "model",
      "fallbackModel",
      "provider",
      "dynamicModel",
      "dynamicProvider",
    ];

    const views = [
      await app.service.getGlobalSettings(),
      await app.service.getProjectSettings(app.first.id),
      await app.service.updateProjectSettings(app.first.id, {
        maxFindings: 2,
      }),
      await app.service.updateProjectSettings(app.first.id, {
        catalogEntryDynamic: entry.id,
      }),
      await app.service.resetProjectSettings(app.first.id),
    ];

    for (const view of views) {
      const text = JSON.stringify(view);
      for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
      for (const key of keysOf(view)) expect(forbiddenKeys).not.toContain(key);
    }
  });

  // #430-T08
  it("list the entries of a kind with an id, a name, a description, whether it can be chosen and why not", async () => {
    const app = await start({ managed: true });
    const alpha = await app.catalog.entry({ name: "Alpha" });
    await app.catalog.entry({ name: "Bravo", kinds: ["diff"] });
    await app.catalog.entry({ name: "Charlie", kinds: ["dynamic"] });
    const delta = await app.catalog.entry({ name: "Delta", status: "retired" });
    await app.catalog.entry({ name: "Echo", status: "retired" });
    await app.catalog.entry({ name: "Foxtrot", status: "draft" });
    const golf = await app.catalog.entry({ name: "Golf" });
    app.catalog.forbid(golf.id);
    await app.projects.updateSettingsWith(app.first.id, () => ({
      catalogEntryDiff: delta.id,
    }));

    const view = await app.service.getProjectSettings(app.first.id);

    const summary = (kind: "diff" | "dynamic") =>
      view.catalogChoices?.[kind].map((choice) => [
        choice.name,
        choice.available,
        choice.reason,
      ]);
    // A retired entry is listed only while the project has it chosen (locked, so the page can say why); a draft never.
    expect(summary("diff")).toEqual([
      ["Alpha", true, null],
      ["Bravo", true, null],
      ["Delta", false, "CATALOG_ENTRY_NOT_RELEASED"],
      ["Golf", false, "CATALOG_ENTRY_NOT_ALLOWED"],
    ]);
    expect(summary("dynamic")).toEqual([
      ["Alpha", true, null],
      ["Charlie", true, null],
      ["Golf", false, "CATALOG_ENTRY_NOT_ALLOWED"],
    ]);
    expect(view.catalogChoices?.diff[0]).toEqual({
      id: alpha.id,
      name: "Alpha",
      description: alpha.description,
      available: true,
      reason: null,
    });
    expect(view.catalogSelection).toEqual({ diff: delta.id, dynamic: null });
  });

  // #430-T08
  it("show no catalog to a workspace on its own key, and none in the workspace defaults", async () => {
    const own = await start({ managed: false });
    const entry = await own.catalog.entry();
    await own.projects.updateSettingsWith(own.first.id, () => ({
      catalogEntryDiff: entry.id,
      model: "vendor/own-model",
    }));

    const view = await own.service.getProjectSettings(own.first.id);
    const global = await own.service.getGlobalSettings();

    expect(view.catalogChoices).toBeNull();
    expect(view.catalogSelection).toBeNull();
    expect(JSON.stringify(view)).not.toContain(entry.id);
    expect(view.effective.model).toBe("vendor/own-model");
    expect(Object.keys(global)).not.toContain("catalogChoices");
  });
});

describe("resetting the settings of a project", () => {
  // #430-T09
  it("keeps the models a managed workspace stored on its own key, and clears its catalog entries", async () => {
    const app = await start({ managed: true });
    const entry = await app.catalog.entry();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      maxFindings: 9,
      provider: "openrouter",
      model: "vendor/own-model",
      fallbackModel: "vendor/own-fallback",
      dynamicModel: "vendor/own-dynamic",
      dynamicProvider: "openrouter",
      catalogEntryDiff: entry.id,
      catalogEntryDynamic: entry.id,
      reviewKind: "dynamic",
    }));

    await app.service.resetProjectSettings(app.first.id);

    expect(await app.stored()).toEqual({
      provider: "openrouter",
      model: "vendor/own-model",
      fallbackModel: "vendor/own-fallback",
      dynamicModel: "vendor/own-dynamic",
      dynamicProvider: "openrouter",
    });
  });

  // #430-T09
  it("keeps the catalog entries a workspace on its own key still has stored, and clears everything else", async () => {
    const app = await start({ managed: false });
    const entry = await app.catalog.entry();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      maxFindings: 9,
      provider: "openrouter",
      model: "vendor/own-model",
      dynamicProvider: "openrouter",
      catalogEntryDiff: entry.id,
    }));

    await app.service.resetProjectSettings(app.first.id);

    expect(await app.stored()).toEqual({ catalogEntryDiff: entry.id });
  });
});

describe("the routes of a workspace on the operator's key", () => {
  const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;

  async function startRoutes() {
    const app = await start({ managed: true });
    const handlers = createReviewSettingsRouteHandlers({
      requireUser: async () => USER,
      service: app.service,
    });
    const path = `https://app.test/api/repositories/${app.first.id}/project/settings`;
    return {
      ...app,
      put: (settings: unknown) =>
        handlers.putProject(
          new Request(path, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ settings }),
          }),
          app.first.id,
        ),
      get: () => handlers.getProject(new Request(path), app.first.id),
      delete: () =>
        handlers.deleteProject(
          new Request(path, { method: "DELETE" }),
          app.first.id,
        ),
    };
  }

  // #430-T08
  it("answer a save, a read and a reset with the choices and never with a model or a provider", async () => {
    const app = await startRoutes();
    const entry = await app.catalog.entry({
      modelId: "sentinel/entry-model-route",
    });
    await app.projects.updateSettingsWith(app.first.id, () => ({
      model: "sentinel/own-model",
      provider: "openrouter",
    }));

    const responses = [
      await app.put({ catalogEntryDiff: entry.id }),
      await app.get(),
      await app.delete(),
    ];

    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("sentinel/");
      expect(text).not.toContain("openrouter");
      expect(keysOf(JSON.parse(text))).not.toContain("provider");
      expect(keysOf(JSON.parse(text))).not.toContain("model");
    }
    const saved = (await (await app.get()).json()) as {
      catalogChoices: { diff: Array<{ id: string }> };
    };
    expect(saved.catalogChoices.diff.map((choice) => choice.id)).toEqual([
      entry.id,
    ]);
  });

  // #430-T05, #430-T07
  it("answer a refused model with MODEL_MANAGED_BY_INSTANCE and a refused entry with its code, both a 400", async () => {
    const app = await startRoutes();
    const draft = await app.catalog.entry({ status: "draft" });

    const model = await app.put({ provider: "openrouter" });
    const entry = await app.put({ catalogEntryDynamic: draft.id });

    expect(model.status).toBe(400);
    expect(await model.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "provider", code: "MODEL_MANAGED_BY_INSTANCE" }],
    });
    expect(entry.status).toBe(400);
    expect(await entry.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "catalogEntryDynamic", code: "CATALOG_ENTRY_NOT_RELEASED" },
      ],
    });
  });
});
