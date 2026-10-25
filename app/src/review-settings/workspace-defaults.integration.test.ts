// SPDX-License-Identifier: LicenseRef-Proprietary

// #676: the review kind, the Dynamic provider and model (a catalog entry per kind on the operator's key) and the verdict as
// workspace defaults, against a real database: what a save stores beside the Diff defaults, how a project inherits and
// overrides them, what the claim resolves, and what another workspace and a workspace on the other key mode never see.
import { describe, expect, it, vi } from "vitest";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "../llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../llm/providers/registry.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  createCatalogFixture,
  setupReviewSettings,
} from "../test-support/review-settings-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { ReviewSettingsError } from "./errors.ts";
import type { ReviewSettingsHooks } from "./hooks.ts";
import type { ReviewSettingIssue } from "./validate.ts";

const TWO_PROVIDERS = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);
const DEFAULT_PROVIDER = openrouterDescriptor.id;

async function issuesOf(
  promise: Promise<unknown>,
): Promise<readonly ReviewSettingIssue[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReviewSettingsError) return error.issues;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

async function errorOf(
  promise: Promise<unknown>,
): Promise<ReviewSettingsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReviewSettingsError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

/** A clock that moves one second with every save, so two saves have different times. */
function ticking(): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 9, 10, 8, 0, seconds++));
}

async function start(
  options: {
    managed?: boolean;
    hooks?: ReviewSettingsHooks;
    modelCapabilities?: ModelCapabilityChecker;
    dynamicReady?: Parameters<typeof setupReviewSettings>[1] extends
      { dynamicReady?: infer Ready } | undefined
      ? Ready
      : never;
    settingsClock?: () => Date;
  } = {},
) {
  const { db } = await createTestDatabase();
  const catalog = createCatalogFixture(db);
  const app = await setupReviewSettings(db, {
    operatorsModels: options.managed === true,
    catalog: catalog.source,
    providers: TWO_PROVIDERS,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.modelCapabilities === undefined
      ? {}
      : { modelCapabilities: options.modelCapabilities }),
    ...(options.dynamicReady === undefined
      ? {}
      : { dynamicReady: options.dynamicReady }),
    ...(options.settingsClock === undefined
      ? {}
      : { settingsClock: options.settingsClock }),
  });
  await app.projects.activate(app.first.id);
  return { ...app, catalog };
}

describe("saving the workspace defaults", () => {
  // #676-T01
  it("stores the kind, the Dynamic provider and model and the verdict next to the Diff defaults, and shows them back", async () => {
    const app = await start();

    const saved = await app.service.updateGlobalSettings(
      {
        maxFindings: 9,
        reviewKind: "dynamic",
        dynamicProvider: FAKE_PROVIDER_ID,
        dynamicModel: "fake-large",
        reviewVerdict: "any",
      },
      "ada",
    );

    expect((await app.appSettings.get("review_defaults"))?.value).toEqual({
      maxFindings: 9,
      reviewKind: "dynamic",
      dynamicProvider: FAKE_PROVIDER_ID,
      dynamicModel: "fake-large",
      reviewVerdict: "any",
    });
    expect(saved.overrides).toEqual({ maxFindings: 9 });
    expect(saved.dynamic.overrides).toEqual({
      reviewKind: "dynamic",
      dynamicProvider: FAKE_PROVIDER_ID,
      dynamicModel: "fake-large",
      reviewVerdict: "any",
    });
    expect(saved.dynamic.effective).toMatchObject({
      reviewKind: "dynamic",
      dynamicModel: "fake-large",
      reviewVerdict: "any",
    });
    // The values below the defaults are the shipped ones.
    expect(saved.dynamic.defaults).toMatchObject({
      reviewKind: "diff",
      dynamicProvider: DEFAULT_PROVIDER,
      reviewVerdict: "blocking",
    });
    expect(saved.catalogChoices).toBeNull();
  });

  // #676-T01
  it("replaces the whole set: a default left out of the next save is taken back", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      { reviewKind: "dynamic", reviewVerdict: "any", maxFindings: 9 },
      "ada",
    );

    const saved = await app.service.updateGlobalSettings(
      { maxFindings: 9 },
      "ada",
    );

    expect((await app.appSettings.get("review_defaults"))?.value).toEqual({
      maxFindings: 9,
    });
    expect(saved.dynamic.overrides).toEqual({});
    expect(saved.dynamic.effective.reviewKind).toBe("diff");
  });

  // #676-T07
  it("keeps the review skill a project's", async () => {
    const app = await start();

    expect(
      await issuesOf(
        app.service.updateGlobalSettings({ reviewSkill: "my skill" }, "ada"),
      ),
    ).toEqual([{ field: "reviewSkill", code: "UNKNOWN_FIELD" }]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #676-T07
  it("puts a Dynamic model to the provider's metadata check, like a project's, and stores nothing when it is refused", async () => {
    const check = vi.fn<ModelCapabilityChecker["check"]>(async () => ({
      outcome: "unknown_model",
    }));
    const app = await start({
      modelCapabilities: { check } as unknown as ModelCapabilityChecker,
    });

    const refused = await issuesOf(
      app.service.updateGlobalSettings(
        { dynamicModel: "vendor/no-such-model" },
        "ada",
      ),
    );

    expect(check).toHaveBeenCalledWith("vendor/no-such-model", {
      provider: DEFAULT_PROVIDER,
    });
    expect(refused).toEqual([
      { field: "dynamicModel", code: "DYNAMIC_MODEL_UNKNOWN" },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #676-T07
  it("is the workspace's own: another workspace sees nothing of it", async () => {
    const app = await start();
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
    const other = await addWorkspace(app.db, "other");

    const stored = await createAppSettingsRepository(app.db, other).get(
      "review_defaults",
    );

    expect(stored).toBeUndefined();
  });

  // #676-T07
  it("refuses a project provider next to a workspace model of another provider, and stores nothing", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      { dynamicProvider: FAKE_PROVIDER_ID, dynamicModel: "fake-large" },
      "ada",
    );
    const before = await app.projectRows();

    const refused = await issuesOf(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: DEFAULT_PROVIDER,
      }),
    );

    expect(refused).toEqual([
      { field: "dynamicProvider", code: "MODEL_PROVIDER_MISMATCH" },
    ]);
    expect(await app.projectRows()).toEqual(before);
  });

  // #676-T07
  it("refuses a workspace model that would pair with the provider a project holds, and stores nothing", async () => {
    const app = await start();
    await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: DEFAULT_PROVIDER,
    });

    const refused = await issuesOf(
      app.service.updateGlobalSettings(
        { dynamicProvider: FAKE_PROVIDER_ID, dynamicModel: "fake-large" },
        "ada",
      ),
    );

    expect(refused).toEqual([
      { field: "dynamicModel", code: "MODEL_PROVIDER_MISMATCH" },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });
});

describe("a project and the workspace defaults", () => {
  // #676-T02
  it("follows the defaults it sets nothing for, says so, and wins over them where it sets a value", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      { reviewKind: "dynamic", reviewVerdict: "any" },
      "ada",
    );

    const following = await app.service.getProjectSettings(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "diff",
    });
    const own = await app.service.getProjectSettings(app.first.id);

    expect(following.dynamic).toMatchObject({
      overrides: {},
      effective: { reviewKind: "dynamic", reviewVerdict: "any" },
      defaults: { reviewKind: "dynamic", reviewVerdict: "any" },
      sources: { reviewKind: "global", reviewVerdict: "global" },
    });
    expect(own.dynamic).toMatchObject({
      overrides: { reviewKind: "diff" },
      effective: { reviewKind: "diff", reviewVerdict: "any" },
      // "Reset to default" returns to what the workspace chose, not to the shipped value.
      defaults: { reviewKind: "dynamic", reviewVerdict: "any" },
      sources: { reviewKind: "project", reviewVerdict: "global" },
    });
  });

  // #676-T02
  it("returns to the workspace default when the project is reset", async () => {
    const app = await start();
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "diff",
    });

    const reset = await app.service.resetProjectSettings(app.first.id);

    expect(reset.dynamic.effective.reviewKind).toBe("dynamic");
    expect(reset.dynamic.sources.reviewKind).toBe("global");
  });

  // #676-T02
  it("follows a change of the defaults made later, and a default taken back", async () => {
    const app = await start();
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
    await app.service.updateGlobalSettings({ reviewVerdict: "off" }, "ada");

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.dynamic.effective).toMatchObject({
      reviewKind: "diff",
      reviewVerdict: "off",
    });
  });

  // #676-T02
  it("counts the workspace default as the kind it leaves: a project that sets its own kind to the default's changes nothing", async () => {
    const changed = vi.fn<ReviewSettingsHooks["onProjectSettingsChanged"]>(
      async () => undefined,
    );
    const app = await start({ hooks: { onProjectSettingsChanged: changed } });
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");

    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
    });
    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "diff",
    });

    expect(changed.mock.calls.map(([event]) => event)).toMatchObject([
      { previousKind: "dynamic", nextKind: "dynamic", kindChanged: false },
      { previousKind: "dynamic", nextKind: "diff", kindChanged: true },
    ]);
  });
});

describe("what the claim resolves", () => {
  // #676-T03
  it("hands on the workspace default of the Dynamic provider and model apart from the project's", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      {
        reviewKind: "dynamic",
        dynamicProvider: FAKE_PROVIDER_ID,
        dynamicModel: "fake-large",
      },
      "ada",
    );

    const inherited = await app.service.resolveForRepository(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: DEFAULT_PROVIDER,
      dynamicModel: "vendor/own-dynamic-model",
    });
    const own = await app.service.resolveForRepository(app.first.id);

    expect(inherited?.dynamic).toMatchObject({
      reviewKind: "dynamic",
      dynamicProvider: FAKE_PROVIDER_ID,
      dynamicModel: "fake-large",
    });
    expect(inherited?.modelLayers.dynamic).toEqual({
      workspace: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      project: {},
    });
    expect(own?.dynamic).toMatchObject({
      dynamicProvider: DEFAULT_PROVIDER,
      dynamicModel: "vendor/own-dynamic-model",
    });
    expect(own?.modelLayers.dynamic).toEqual({
      workspace: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      project: {
        provider: DEFAULT_PROVIDER,
        model: "vendor/own-dynamic-model",
      },
    });
  });

  // #676-T03
  it("uses the shipped Dynamic model while neither layer sets one", async () => {
    const app = await start();
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");

    const resolved = await app.service.resolveForRepository(app.first.id);

    expect(resolved?.modelLayers.dynamic).toEqual({
      workspace: {},
      project: {},
    });
    expect(resolved?.dynamic.sources.dynamicModel).toBe("built_in");
  });
});

describe("the defaults of a workspace on the operator's key", () => {
  // #676-T01
  it("choose a catalog entry per kind, shown by name, and carry no model", async () => {
    const app = await start({ managed: true });
    const quick = await app.catalog.entry({
      name: "Quick look",
      kinds: ["diff"],
    });
    const explorer = await app.catalog.entry({
      name: "Explorer",
      kinds: ["dynamic"],
    });

    const saved = await app.service.updateGlobalSettings(
      { catalogEntryDiff: quick.id, catalogEntryDynamic: explorer.id },
      "ada",
    );

    expect(saved.catalogSelection).toEqual({
      diff: quick.id,
      dynamic: explorer.id,
    });
    expect(saved.catalogChoices?.dynamic.map((entry) => entry.name)).toEqual([
      "Explorer",
    ]);
    expect(JSON.stringify(saved)).not.toContain("sentinel/entry-model");
    expect(saved.modelManagedByInstance).toBe(true);
  });

  // #676-T03
  it("are followed by a project that selects no entry, which wins where it selects one", async () => {
    const app = await start({ managed: true });
    const workspaceEntry = await app.catalog.entry({ kinds: ["dynamic"] });
    const projectEntry = await app.catalog.entry({ kinds: ["dynamic"] });
    await app.service.updateGlobalSettings(
      { reviewKind: "dynamic", catalogEntryDynamic: workspaceEntry.id },
      "ada",
    );

    const following = await app.service.getProjectSettings(app.first.id);
    const followed = await app.service.resolveForRepository(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      catalogEntryDynamic: projectEntry.id,
    });
    const own = await app.service.resolveForRepository(app.first.id);

    expect(following.catalogWorkspaceSelection).toEqual({
      diff: null,
      dynamic: workspaceEntry.id,
    });
    expect(following.catalogSelection).toEqual({ diff: null, dynamic: null });
    expect(followed?.dynamic.catalogEntryDynamic).toBe(workspaceEntry.id);
    expect(own?.dynamic.catalogEntryDynamic).toBe(projectEntry.id);
  });

  // #676-T07
  it("check an entry like a project's: unknown, not released, wrong kind and not in the plan are refused by field", async () => {
    const app = await start({ managed: true });
    const draft = await app.catalog.entry({ status: "draft" });
    const diffOnly = await app.catalog.entry({ kinds: ["diff"] });
    const forbidden = await app.catalog.entry();
    app.catalog.forbid(forbidden.id);

    const issues = await issuesOf(
      app.service.updateGlobalSettings(
        {
          catalogEntryDiff: draft.id,
          catalogEntryDynamic: diffOnly.id,
        },
        "ada",
      ),
    );
    const forbiddenIssues = await issuesOf(
      app.service.updateGlobalSettings(
        { catalogEntryDiff: forbidden.id },
        "ada",
      ),
    );

    expect(issues).toEqual([
      { field: "catalogEntryDiff", code: "CATALOG_ENTRY_NOT_RELEASED" },
      { field: "catalogEntryDynamic", code: "CATALOG_ENTRY_KIND_MISMATCH" },
    ]);
    expect(forbiddenIssues).toEqual([
      { field: "catalogEntryDiff", code: "CATALOG_ENTRY_NOT_ALLOWED" },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #676-T07
  it("refuse a Dynamic provider or model by name, before any value is looked at", async () => {
    const app = await start({ managed: true });

    const issues = await issuesOf(
      app.service.updateGlobalSettings(
        { dynamicProvider: "nope", dynamicModel: 7 },
        "ada",
      ),
    );

    expect(issues).toEqual([
      { field: "dynamicProvider", code: "MODEL_MANAGED_BY_INSTANCE" },
      { field: "dynamicModel", code: "MODEL_MANAGED_BY_INSTANCE" },
    ]);
  });

  // #676-T07
  it("keep the models saved on the workspace's own key, and the entries survive a return to it", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      {
        provider: DEFAULT_PROVIDER,
        model: "vendor/diff-model",
        dynamicProvider: DEFAULT_PROVIDER,
        dynamicModel: "vendor/dynamic-model",
      },
      "ada",
    );
    app.setOperatorsModels(true);
    const entry = await app.catalog.entry({ kinds: ["dynamic"] });

    const managed = await app.service.updateGlobalSettings(
      { catalogEntryDynamic: entry.id, reviewKind: "dynamic" },
      "ada",
    );
    const whileManaged = (await app.appSettings.get("review_defaults"))?.value;
    app.setOperatorsModels(false);
    const back = await app.service.updateGlobalSettings(
      { maxFindings: 4 },
      "ada",
    );

    expect(JSON.stringify(managed)).not.toContain("vendor/dynamic-model");
    // The save of the managed workspace could not set the models, and did not drop them.
    expect(whileManaged).toEqual({
      reviewKind: "dynamic",
      catalogEntryDynamic: entry.id,
      provider: DEFAULT_PROVIDER,
      model: "vendor/diff-model",
      dynamicProvider: DEFAULT_PROVIDER,
      dynamicModel: "vendor/dynamic-model",
    });
    // Back on its own key a save replaces the set, but the entry chosen on the operator's key stays stored, unseen.
    expect((await app.appSettings.get("review_defaults"))?.value).toEqual({
      maxFindings: 4,
      catalogEntryDynamic: entry.id,
    });
    expect(back.catalogSelection).toBeNull();
    expect(JSON.stringify(back)).not.toContain(entry.id);
  });
});

describe("the defaults of a workspace on its own key", () => {
  // #676-T07
  it("refuse a catalog entry: an own key never reads the catalog", async () => {
    const app = await start();
    const entry = await app.catalog.entry();

    const issues = await issuesOf(
      app.service.updateGlobalSettings({ catalogEntryDiff: entry.id }, "ada"),
    );

    expect(issues).toEqual([
      { field: "catalogEntryDiff", code: "CATALOG_ENTRY_OWN_KEY_MODE" },
    ]);
    expect(app.catalog.reads.count).toBe(0);
  });
});

// The review of #679: what a save of the workspace defaults may break or overwrite.
describe("a save of the workspace defaults that would break a project (review fix 2)", () => {
  // #676-T07
  it("is refused when a project holds a Dynamic model of its own and no provider, and names the project", async () => {
    const app = await start();
    await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/own-model",
    });

    const refused = await errorOf(
      app.service.updateGlobalSettings(
        { dynamicProvider: FAKE_PROVIDER_ID },
        "ada",
      ),
    );

    expect(refused.issues).toEqual([
      { field: "dynamicProvider", code: "PROJECT_MODEL_BOUND_TO_PROVIDER" },
    ]);
    expect(refused.projects).toEqual([app.first.fullName]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #676-T07
  it("is refused for the Diff provider and model the same way", async () => {
    const app = await start();
    await app.service.updateProjectSettings(app.first.id, {
      model: "vendor/own-model",
    });

    const refused = await errorOf(
      app.service.updateGlobalSettings({ provider: FAKE_PROVIDER_ID }, "ada"),
    );

    expect(refused.issues).toEqual([
      { field: "provider", code: "PROJECT_MODEL_BOUND_TO_PROVIDER" },
    ]);
    expect(refused.projects).toEqual([app.first.fullName]);
  });

  // #676-T07
  it("goes through when the provider stays, when the project holds its own provider too, or when it holds no model", async () => {
    const app = await start();
    await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: FAKE_PROVIDER_ID,
      dynamicModel: "fake-large",
    });
    await app.service.updateProjectSettings(app.second.id, {
      reviewVerdict: "off",
    });
    // The workspace default keeps the default provider; the project that sets its own pair is not affected.
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");

    const saved = await app.service.updateGlobalSettings(
      { dynamicProvider: FAKE_PROVIDER_ID },
      "ada",
    );

    expect(saved.dynamic.overrides).toEqual({
      dynamicProvider: FAKE_PROVIDER_ID,
    });
  });
});

describe("Dynamic Review as the workspace default (review fix 3)", () => {
  // #676-T04
  it("is refused when Dynamic Review cannot run for the workspace, and stores nothing", async () => {
    const asked = vi.fn(async () => false);
    const app = await start({ dynamicReady: asked });

    const refused = await errorOf(
      app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada"),
    );

    expect(refused.issues).toEqual([
      { field: "reviewKind", code: "DYNAMIC_REVIEW_NOT_READY" },
    ]);
    expect(asked).toHaveBeenCalledWith(
      expect.objectContaining({ reviewKind: "dynamic" }),
    );
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #676-T04
  it("is saved when it can run, and Diff Review is never asked about", async () => {
    let ready = true;
    const app = await start({ dynamicReady: async () => ready });
    ready = false;
    await app.service.updateGlobalSettings({ reviewKind: "diff" }, "ada");
    ready = true;

    const saved = await app.service.updateGlobalSettings(
      { reviewKind: "dynamic" },
      "ada",
    );

    expect(saved.dynamic.effective.reviewKind).toBe("dynamic");
  });

  // #676-T04
  it("does not block an unrelated save of defaults that were set up while the key was there, but a change of the model it runs on is asked again", async () => {
    let ready = true;
    const app = await start({ dynamicReady: async () => ready });
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
    ready = false;

    await app.service.updateGlobalSettings(
      { reviewKind: "dynamic", maxFindings: 5 },
      "ada",
    );
    const refused = await errorOf(
      app.service.updateGlobalSettings(
        { reviewKind: "dynamic", dynamicModel: "vendor/other-model" },
        "ada",
      ),
    );

    expect(refused.issues).toEqual([
      { field: "reviewKind", code: "DYNAMIC_REVIEW_NOT_READY" },
    ]);
  });
});

describe("a stale save of the workspace defaults (review fix 4)", () => {
  // #676-T09
  it("is refused when the defaults were saved since the form was read, and stores nothing of it", async () => {
    const app = await start({ settingsClock: ticking() });
    const first = await app.service.updateGlobalSettings(
      { maxFindings: 9 },
      "ada",
    );
    await app.service.updateGlobalSettings({ maxFindings: 8 }, "bo");

    const refused = await errorOf(
      app.service.updateGlobalSettings({ maxFindings: 7 }, "ada", {
        expectedUpdatedAt: first.updatedAt,
      }),
    );

    expect(refused.code).toBe("REVIEW_SETTINGS_STALE");
    expect((await app.appSettings.get("review_defaults"))?.value).toEqual({
      maxFindings: 8,
    });
  });

  // #676-T09
  it("is accepted when nothing changed since, from the first save on and after it, and a save that names no version still replaces", async () => {
    const app = await start({ settingsClock: ticking() });
    const never = await app.service.getGlobalSettings();
    expect(never.updatedAt).toBeNull();

    const first = await app.service.updateGlobalSettings(
      { maxFindings: 9 },
      "ada",
      { expectedUpdatedAt: never.updatedAt },
    );
    const second = await app.service.updateGlobalSettings(
      { maxFindings: 8 },
      "ada",
      { expectedUpdatedAt: first.updatedAt },
    );
    const last = await app.service.updateGlobalSettings(
      { maxFindings: 7 },
      "bo",
    );

    expect(second.overrides).toEqual({ maxFindings: 8 });
    expect(last.overrides).toEqual({ maxFindings: 7 });
  });

  // #676-T09
  it("is refused for a form that read the defaults before any was saved, once somebody saved", async () => {
    const app = await start({ settingsClock: ticking() });
    await app.service.updateGlobalSettings({ maxFindings: 9 }, "bo");

    const refused = await errorOf(
      app.service.updateGlobalSettings({ maxFindings: 7 }, "ada", {
        expectedUpdatedAt: null,
      }),
    );

    expect(refused.code).toBe("REVIEW_SETTINGS_STALE");
  });
});

describe("the review kind of a project that follows the defaults (review fix 6)", () => {
  // #676-T02
  it("is the workspace default in the event of a save that sets something else", async () => {
    const changed = vi.fn<ReviewSettingsHooks["onProjectSettingsChanged"]>(
      async () => undefined,
    );
    const app = await start({ hooks: { onProjectSettingsChanged: changed } });
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");

    await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "off",
    });

    expect(changed.mock.calls.map(([event]) => event)).toMatchObject([
      { previousKind: "dynamic", nextKind: "dynamic", kindChanged: false },
    ]);
  });

  // #676-T02
  it("is the same before and after the reset of a project that followed the default, and changes for one that had its own kind", async () => {
    const changed = vi.fn<ReviewSettingsHooks["onProjectSettingsChanged"]>(
      async () => undefined,
    );
    const app = await start({ hooks: { onProjectSettingsChanged: changed } });
    await app.service.updateGlobalSettings({ reviewKind: "dynamic" }, "ada");
    await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "off",
    });
    await app.projects.activate(app.second.id);
    await app.service.updateProjectSettings(app.second.id, {
      reviewKind: "diff",
    });
    changed.mockClear();

    await app.service.resetProjectSettings(app.first.id);
    await app.service.resetProjectSettings(app.second.id);

    expect(changed.mock.calls.map(([event]) => event)).toMatchObject([
      { previousKind: "dynamic", nextKind: "dynamic", kindChanged: false },
      { previousKind: "diff", nextKind: "dynamic", kindChanged: true },
    ]);
  });
});
