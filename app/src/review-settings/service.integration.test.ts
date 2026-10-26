// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the review settings service against a real Postgres database: the global defaults and the
// overrides of a project are two layers that are combined when they are read, a change of the global
// defaults reaches every project that does not override the field, resetting an override brings the
// project back to the global value, bad input is refused with the affected fields and stores nothing,
// and stored data that is no longer valid cannot break a review.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { ReviewSettingsError } from "./errors.ts";
import {
  setupReviewSettings,
  TEST_DEFAULT_SKILL,
  TEST_MODEL,
} from "../test-support/review-settings-harness.ts";
import { DEFAULT_DYNAMIC_MODEL } from "./settings.ts";

async function refusal(
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

// #656-T04
describe("the cost limit of a review", () => {
  it("is the workspace default for a project that sets none, and the project's own once it does", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    const none = await app.service.getProjectSettings(app.first.id);
    await app.service.updateGlobalSettings({ maxCostCents: 80 }, "octocat");
    const inherited = await app.service.getProjectSettings(app.first.id);
    const own = await app.service.updateProjectSettings(app.first.id, {
      maxCostCents: 50,
    });
    const back = await app.service.updateProjectSettings(app.first.id, {});

    expect(none.effective.maxCostCents).toBeNull();
    expect(inherited.effective.maxCostCents).toBe(80);
    expect(inherited.sources.maxCostCents).toBe("global");
    expect(inherited.inherited.maxCostCents).toBe(80);
    expect(own.effective.maxCostCents).toBe(50);
    expect(own.sources.maxCostCents).toBe("project");
    expect(back.effective.maxCostCents).toBe(80);
  });
});

// #656-T02
describe("a new project", () => {
  it("is Dynamic Review from the start, also on the page of a repository that has no project yet", async () => {
    const app = await setupReviewSettings(undefined, {
      newProjectSettings: async () => ({ reviewKind: "dynamic" }),
    });

    const before = await app.service.getProjectSettings(app.first.id);
    await app.projects.activate(app.first.id);
    const after = await app.service.getProjectSettings(app.first.id);

    expect(before.dynamic.effective.reviewKind).toBe("dynamic");
    expect(after.dynamic.effective.reviewKind).toBe("dynamic");
  });

  it("is Diff Review where nothing asks for another kind, and a project that exists keeps its kind", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.dynamic.effective.reviewKind).toBe("diff");
  });
});

describe("the global defaults", () => {
  it("are the built-in values until somebody saves some, with the model of the instance", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.getGlobalSettings();

    expect(view.overrides).toEqual({});
    expect(view.effective.model).toBe(TEST_MODEL);
    expect(view.effective.largePrChunking).toBe(true);
    expect(view.updatedAt).toBeNull();
    expect(Object.values(view.sources)).toEqual(
      Object.values(view.sources).map(() => "built_in"),
    );
    expect(view.cost?.warn).toBe(false);
  });

  it("follow a changed model of the instance as long as nobody chose one", async () => {
    const app = await setupReviewSettings();

    app.setInstanceModel("qwen/qwen3-coder");

    expect((await app.service.getGlobalSettings()).effective.model).toBe(
      "qwen/qwen3-coder",
    );
  });

  it("save only what was given, remember who saved them, and show where each value comes from", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.updateGlobalSettings(
      { maxFindings: 8, extraInstructions: "Be strict." },
      "octocat",
    );

    expect(view.overrides).toEqual({
      maxFindings: 8,
      extraInstructions: "Be strict.",
    });
    expect(view.effective).toMatchObject({
      maxFindings: 8,
      extraInstructions: "Be strict.",
      model: TEST_MODEL,
    });
    expect(view.sources).toMatchObject({
      maxFindings: "global",
      extraInstructions: "global",
      model: "built_in",
    });
    expect(view.updatedBy).toBe("octocat");
    expect(view.updatedAt).not.toBeNull();
    expect(await app.appSettingRows()).toMatchObject([
      { key: "review_defaults", updated_by: "octocat" },
    ]);
  });

  it("go back to the built-in value for a field that is left out of the next save", async () => {
    const app = await setupReviewSettings();
    await app.service.updateGlobalSettings(
      { maxFindings: 8, inlineKeyIssues: true },
      "octocat",
    );

    const view = await app.service.updateGlobalSettings(
      { inlineKeyIssues: false },
      "hubot",
    );

    expect(view.overrides).toEqual({ inlineKeyIssues: false });
    expect(view.effective.maxFindings).toBe(5);
    expect(view.updatedBy).toBe("hubot");
  });

  // #178 review M2: the "Reset every default" danger zone sends an empty patch; it must clear the global
  // layer and leave the overrides of a project alone.
  it("clear every global override with an empty patch, and keep a project's own overrides", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings(
      { maxFindings: 8, inlineKeyIssues: true },
      "octocat",
    );
    await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 3,
      largePrChunking: false,
    });

    const view = await app.service.updateGlobalSettings({}, "hubot");

    expect(view.overrides).toEqual({});
    expect(view.effective.maxFindings).toBe(5);
    expect(view.effective.inlineKeyIssues).toBe(false);
    expect(view.updatedBy).toBe("hubot");
    expect(await app.appSettingRows()).toMatchObject([
      { key: "review_defaults", value: "{}", updated_by: "hubot" },
    ]);
    const project = await app.service.getProjectSettings(app.first.id);
    expect(project.overrides).toEqual({
      maxFindings: 3,
      largePrChunking: false,
    });
    expect(project.effective.maxFindings).toBe(3);
    expect(project.effective.largePrChunking).toBe(false);
  });

  // #434-T03
  it("refuse the old quality level as an unknown field, and store nothing", async () => {
    const app = await setupReviewSettings();
    const legacy = ["model", "Tier"].join("");

    await expect(
      app.service.updateGlobalSettings({ [legacy]: "high" }, "octocat"),
    ).rejects.toMatchObject({
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: legacy, code: "UNKNOWN_FIELD" }],
    });
    expect(await app.appSettingRows()).toEqual([]);
  });

  // CR-25-T07
  it("refuse invalid settings with the fields that are wrong, and store nothing", async () => {
    const app = await setupReviewSettings();

    const error = await refusal(
      app.service.updateGlobalSettings(
        { maxFindings: 0, model: "" },
        "octocat",
      ),
    );

    expect(error.code).toBe("REVIEW_SETTINGS_INVALID");
    expect(error.issues).toEqual([
      { field: "maxFindings", code: "TOO_SMALL" },
      { field: "model", code: "EMPTY" },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  it("warn about a model that is estimated above the cost limit, without refusing it", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.updateGlobalSettings(
      { model: "anthropic/claude-opus-5.5" },
      "octocat",
    );

    expect(view.cost?.warn).toBe(true);
    expect(view.cost?.primary).toMatchObject({
      status: "estimated",
      aboveLimit: true,
    });
    expect(view.effective.model).toBe("anthropic/claude-opus-5.5");
  });
});

describe("the token budget", () => {
  // #689-T04
  it("is no setting: a save that sends it is refused as an unknown field and stores nothing", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    const global = await refusal(
      app.service.updateGlobalSettings({ maxTokens: 1_000_000 }, "octocat"),
    );
    const project = await refusal(
      app.service.updateProjectSettings(app.first.id, { maxTokens: 50_000 }),
    );

    expect(global.issues).toEqual([
      { field: "maxTokens", code: "UNKNOWN_FIELD" },
    ]);
    expect(project.issues).toEqual([
      { field: "maxTokens", code: "UNKNOWN_FIELD" },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #689-T04
  it("stored with a project before is left in its row, read by nobody, and dropped by the next save", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.projects.updateSettings(app.first.id, {
      maxFindings: 4,
      maxTokens: 60_000,
    });

    const before = await app.service.getProjectSettings(app.first.id);
    const after = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 4,
      inlineKeyIssues: true,
    });

    expect(before.overrides).toEqual({ maxFindings: 4 });
    expect(Object.keys(before.effective)).not.toContain("maxTokens");
    expect(after.overrides).toEqual({ maxFindings: 4, inlineKeyIssues: true });
  });
});

describe("the operator's maximum cost per review", () => {
  // #689-T05
  it("is 1.00 USD until the admin sets one, and every view carries it", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    expect((await app.service.getGlobalSettings()).operatorMaxCostCents).toBe(
      100,
    );
    expect(
      (await app.service.getProjectSettings(app.first.id)).operatorMaxCostCents,
    ).toBe(100);
  });

  // #689-T05
  it("follows what the admin set, for a workspace on its own key and on the operator's key alike", async () => {
    const app = await setupReviewSettings(undefined, { operatorsModels: true });
    await app.setOperatorCostLimit(250);
    await app.projects.activate(app.first.id);

    expect((await app.service.getGlobalSettings()).operatorMaxCostCents).toBe(
      250,
    );
    expect(
      (await app.service.getProjectSettings(app.first.id)).operatorMaxCostCents,
    ).toBe(250);
  });

  // #689-T06
  it("is the most a customer can save as the cost limit of the workspace defaults, named in the refusal", async () => {
    const app = await setupReviewSettings();

    const error = await refusal(
      app.service.updateGlobalSettings({ maxCostCents: 101 }, "octocat"),
    );

    expect(error.issues).toEqual([
      {
        field: "maxCostCents",
        code: "EXCEEDS_OPERATOR_MAXIMUM",
        maximumCents: 100,
      },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #689-T06
  it("is the most a customer can save as the cost limit of a project, and exactly the maximum is fine", async () => {
    const app = await setupReviewSettings(undefined, { operatorsModels: true });
    await app.setOperatorCostLimit(300);
    await app.projects.activate(app.first.id);

    await expect(
      app.service.updateProjectSettings(app.first.id, { maxCostCents: 301 }),
    ).rejects.toMatchObject({
      issues: [
        {
          field: "maxCostCents",
          code: "EXCEEDS_OPERATOR_MAXIMUM",
          maximumCents: 300,
        },
      ],
    });
    const view = await app.service.updateProjectSettings(app.first.id, {
      maxCostCents: 300,
    });
    expect(view.effective.maxCostCents).toBe(300);
  });

  // #689-T07
  it("lowered below a stored limit leaves the stored limit alone: it is cut when a review runs, and an unrelated save is not refused for it", async () => {
    const app = await setupReviewSettings();
    await app.setOperatorCostLimit(1000);
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings({ maxCostCents: 800 }, "octocat");
    await app.service.updateProjectSettings(app.first.id, {
      maxCostCents: 600,
    });

    await app.setOperatorCostLimit(100);
    const global = await app.service.getGlobalSettings();
    const project = await app.service.getProjectSettings(app.first.id);
    // The form sends the limit it holds again with whatever else changed.
    const savedGlobal = await app.service.updateGlobalSettings(
      { maxCostCents: 800, maxFindings: 7 },
      "octocat",
    );
    const savedProject = await app.service.updateProjectSettings(app.first.id, {
      maxCostCents: 600,
      maxFindings: 2,
    });

    expect(global.effective.maxCostCents).toBe(800);
    expect(global.operatorMaxCostCents).toBe(100);
    expect(project.effective.maxCostCents).toBe(600);
    expect(savedGlobal.effective.maxCostCents).toBe(800);
    expect(savedProject.effective.maxCostCents).toBe(600);
    // Setting another amount above the maximum is refused; one within it is fine.
    await expect(
      app.service.updateProjectSettings(app.first.id, { maxCostCents: 700 }),
    ).rejects.toBeInstanceOf(ReviewSettingsError);
    await expect(
      app.service.updateProjectSettings(app.first.id, { maxCostCents: 100 }),
    ).resolves.toBeDefined();
  });
});

describe("the settings of a project", () => {
  // CR-25-T11
  it("see a changed global value until they override it, and the overridden field only after the reset", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.projects.activate(app.second.id);
    await app.service.updateGlobalSettings({ maxFindings: 8 }, "octocat");
    await app.service.updateProjectSettings(app.second.id, { maxFindings: 2 });

    await app.service.updateGlobalSettings({ maxFindings: 12 }, "octocat");
    const plain = await app.service.getProjectSettings(app.first.id);
    const overridden = await app.service.getProjectSettings(app.second.id);

    expect(plain.effective.maxFindings).toBe(12);
    expect(plain.sources.maxFindings).toBe("global");
    expect(overridden.effective.maxFindings).toBe(2);
    expect(overridden.sources.maxFindings).toBe("project");
    expect(overridden.inherited.maxFindings).toBe(12);

    const reset = await app.service.resetProjectSettings(app.second.id);

    expect(reset.overrides).toEqual({});
    expect(reset.effective.maxFindings).toBe(12);
    expect(
      (await app.service.getProjectSettings(app.second.id)).effective
        .maxFindings,
    ).toBe(12);
  });

  // CR-25-T02
  it("combine the overrides of two fields with the global values for all the others", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings(
      { model: "qwen/qwen3-coder", inlineKeyIssues: true },
      "octocat",
    );

    const view = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 2,
      extraInstructions: "Mind the migrations.",
    });

    expect(view.effective).toMatchObject({
      maxFindings: 2,
      extraInstructions: "Mind the migrations.",
      model: "qwen/qwen3-coder",
      inlineKeyIssues: true,
    });
    expect(view).toMatchObject({
      repositoryId: app.first.id,
      active: true,
      overrides: { maxFindings: 2, extraInstructions: "Mind the migrations." },
    });
  });

  it("replace the whole set of overrides on every save", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 2,
      inlineKeyIssues: true,
    });

    const view = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 3,
    });

    expect(view.overrides).toEqual({ maxFindings: 3 });
    expect(view.effective.inlineKeyIssues).toBe(false);
  });

  it("keep a project's overrides while it is switched off", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 2 });

    await app.projects.deactivate(app.first.id);
    const view = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 4,
    });

    expect(view).toMatchObject({
      active: false,
      overrides: { maxFindings: 4 },
    });
  });

  // CR-25-T07
  it("refuse invalid settings and leave the stored overrides as they were", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 2 });

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, { maxFindings: "x" }),
    );

    expect(error.code).toBe("REVIEW_SETTINGS_INVALID");
    expect(error.issues).toEqual([
      { field: "maxFindings", code: "INVALID_TYPE" },
    ]);
    expect((await app.projects.get(app.first.id))?.settings).toEqual({
      maxFindings: 2,
    });
  });

  it("are not found for an unknown repository, for read, save and reset alike", async () => {
    const app = await setupReviewSettings();

    // One call after the other: a call that is started early and awaited late is an unhandled rejection while it waits.
    for (const call of [
      () => app.service.getProjectSettings("no-such-repository"),
      () =>
        app.service.updateProjectSettings("no-such-repository", {
          maxFindings: 2,
        }),
      () => app.service.resetProjectSettings("no-such-repository"),
    ])
      expect((await refusal(call())).code).toBe(
        "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
      );
    expect(await app.projectRows()).toEqual([]);
  });

  // #80
  it("can be read for a repository that was never activated, which shows the defaults and writes nothing", async () => {
    const app = await setupReviewSettings();
    await app.service.updateGlobalSettings({ maxFindings: 8 }, "octocat");

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view).toMatchObject({
      repositoryId: app.first.id,
      projectId: null,
      active: false,
      overrides: {},
      effective: { maxFindings: 8 },
      inherited: { maxFindings: 8 },
    });
    expect(await app.projectRows()).toEqual([]);
  });

  // #80
  it("can be saved for a repository that was never activated, which creates an inactive project and keeps it out of reviews", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 2,
    });

    expect(view).toMatchObject({
      active: false,
      overrides: { maxFindings: 2 },
    });
    expect(view.projectId).not.toBeNull();
    expect(await app.projectRows()).toMatchObject([
      { repository_id: app.first.id, active: 0 },
    ]);
    expect(
      await app.projects.findActiveForRepository(app.first.id),
    ).toBeUndefined();
  });

  // #80
  it("saved before the first activation are still there once the project is activated", async () => {
    const app = await setupReviewSettings();
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 2 });

    await app.projects.activate(app.first.id);

    const view = await app.service.getProjectSettings(app.first.id);
    expect(view).toMatchObject({ active: true, overrides: { maxFindings: 2 } });
    expect(
      (await app.service.resolveForRepository(app.first.id))?.settings
        .maxFindings,
    ).toBe(2);
  });

  // #80
  it("reset for a repository that was never activated writes nothing", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.resetProjectSettings(app.first.id);

    expect(view).toMatchObject({
      projectId: null,
      active: false,
      overrides: {},
    });
    expect(await app.projectRows()).toEqual([]);
  });

  it("cannot be broken by stored data this version would not accept", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.projects.updateSettings(app.first.id, {
      maxFindings: -4,
      removedField: "x",
      model: "qwen/qwen3-coder",
    });
    await app.appSettings.set(
      "review_defaults",
      { maxCostCents: "lots", inlineKeyIssues: true },
      null,
    );

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.overrides).toEqual({ model: "qwen/qwen3-coder" });
    expect(view.effective).toMatchObject({
      model: "qwen/qwen3-coder",
      maxFindings: 5,
      maxCostCents: null,
      inlineKeyIssues: true,
    });
  });
});

describe("stored settings that are not valid JSON", () => {
  it("fall back to the defaults when the global defaults or the settings of a project are damaged", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings({ maxFindings: 8 }, "octocat");
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 2 });
    await sql`update app_settings set value = '{damaged'`.execute(app.db);
    await sql`update projects set settings = 'damaged}'`.execute(app.db);

    const global = await app.service.getGlobalSettings();
    const project = await app.service.getProjectSettings(app.first.id);
    const resolved = await app.service.resolveForRepository(app.first.id);

    expect(global.overrides).toEqual({});
    expect(global.effective.maxFindings).toBe(5);
    expect(project.overrides).toEqual({});
    expect(project.effective.maxFindings).toBe(5);
    expect(resolved?.settings.maxFindings).toBe(5);
    const view = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 3,
    });
    expect(view.effective.maxFindings).toBe(3);
  });
});

describe("resolving the settings for a review", () => {
  it("is the settings of the repository's project, or nothing without a project", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings({ maxFindings: 8 }, "octocat");
    await app.service.updateProjectSettings(app.first.id, {
      autoReviewOnPush: false,
    });

    const resolved = await app.service.resolveForRepository(app.first.id);

    expect(resolved?.settings).toMatchObject({
      maxFindings: 8,
      autoReviewOnPush: false,
      autoReviewOnOpen: true,
    });
    expect(resolved?.sources.autoReviewOnPush).toBe("project");
    expect(
      await app.service.resolveForRepository(app.second.id),
    ).toBeUndefined();
  });
});

// #194-T01, #194-T03, #194-T06: the project-only review kind, Dynamic model and skill as seen
// through the service and the database.
describe("the project-only settings of a project", () => {
  // #194-T01
  it("default to Diff Review with the shipped Dynamic model and skill", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.dynamic.overrides).toEqual({});
    expect(view.dynamic.effective).toEqual({
      reviewKind: "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      dynamicProvider: "openrouter",
      reviewSkill: TEST_DEFAULT_SKILL.text,
      reviewVerdict: "blocking",
    });
    expect(view.dynamic.reviewSkillIsDefault).toBe(true);
    expect(view.dynamic.sources).toEqual({
      reviewKind: "built_in",
      dynamicModel: "built_in",
      dynamicProvider: "built_in",
      reviewSkill: "built_in",
      reviewVerdict: "built_in",
    });
    expect(view.dynamic.defaults).toEqual({
      reviewKind: "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      dynamicProvider: "openrouter",
      reviewSkill: TEST_DEFAULT_SKILL.text,
      reviewVerdict: "blocking",
    });
    expect(view.dynamic.defaultSkill).toEqual({
      id: TEST_DEFAULT_SKILL.id,
      version: TEST_DEFAULT_SKILL.version,
      hash: TEST_DEFAULT_SKILL.hash,
    });
    expect(view.dynamic.limits).toEqual({ reviewSkillMaxBytes: 16_384 });
  });

  // #194-T03
  it("save and reload Dynamic settings while the Diff model is preserved", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    const saved = await app.service.updateProjectSettings(app.first.id, {
      model: "qwen/qwen3-coder",
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "Review for the Dynamic kind.",
    });

    expect(saved.dynamic.effective).toEqual({
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      dynamicProvider: "openrouter",
      reviewSkill: "Review for the Dynamic kind.",
      reviewVerdict: "blocking",
    });
    expect(saved.dynamic.sources).toEqual({
      reviewKind: "project",
      dynamicModel: "project",
      dynamicProvider: "built_in",
      reviewSkill: "project",
      reviewVerdict: "built_in",
    });

    const reloaded = await app.service.getProjectSettings(app.first.id);
    expect(reloaded.dynamic.effective.reviewKind).toBe("dynamic");
    expect(reloaded.dynamic.effective.dynamicModel).toBe(
      "vendor/dynamic-model",
    );
    expect(reloaded.dynamic.effective.reviewSkill).toBe(
      "Review for the Dynamic kind.",
    );
    // The Diff model of the same project survives the kind switch.
    expect(reloaded.effective.model).toBe("qwen/qwen3-coder");
  });

  // #194-T03
  it("can be saved on a project that was never activated and leave it inactive", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });

    expect(view.active).toBe(false);
    expect(view.projectId).not.toBeNull();
    expect(view.dynamic.effective.reviewKind).toBe("dynamic");
    expect(await app.projectRows()).toMatchObject([
      { repository_id: app.first.id, active: 0 },
    ]);
    expect(
      await app.projects.findActiveForRepository(app.first.id),
    ).toBeUndefined();
  });

  // #194-T06
  it("resolve through resolveForRepository together with the Diff settings", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 2,
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });

    const resolved = await app.service.resolveForRepository(app.first.id);

    expect(resolved?.settings.maxFindings).toBe(2);
    expect(resolved?.dynamic.reviewKind).toBe("dynamic");
    expect(resolved?.dynamic.dynamicModel).toBe("vendor/dynamic-model");
    expect(resolved?.dynamic.reviewSkill).toBe(TEST_DEFAULT_SKILL.text);
  });

  // #194-T06
  it("read old settings JSON without the project-only fields as Diff Review", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.projects.updateSettings(app.first.id, {
      model: "qwen/qwen3-coder",
      maxFindings: 2,
    });

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.effective.model).toBe("qwen/qwen3-coder");
    expect(view.effective.maxFindings).toBe(2);
    expect(view.dynamic.effective).toEqual({
      reviewKind: "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      dynamicProvider: "openrouter",
      reviewSkill: TEST_DEFAULT_SKILL.text,
      reviewVerdict: "blocking",
    });
  });

  // #405-T28
  it("save the verdict mode on a project of either kind, show it as the project's own, and keep the Diff overrides", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 2 });

    const saved = await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "any",
    });

    expect(saved.dynamic.effective.reviewVerdict).toBe("any");
    expect(saved.dynamic.sources.reviewVerdict).toBe("project");
    expect(saved.dynamic.overrides).toEqual({ reviewVerdict: "any" });
    // A save of only project-only fields never touches the Diff group.
    expect(saved.overrides).toEqual({ maxFindings: 2 });
    expect(
      (await app.service.getProjectSettings(app.first.id)).dynamic.effective
        .reviewVerdict,
    ).toBe("any");
    expect(
      (await app.service.resolveForRepository(app.first.id))?.dynamic
        .reviewVerdict,
    ).toBe("any");
  });

  // #405-T28
  it("keep the verdict mode through an ordinary Diff-only save, and go back to the default when it is cleared", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "off",
    });

    const afterDiffSave = await app.service.updateProjectSettings(
      app.first.id,
      { maxFindings: 3 },
    );
    const cleared = await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: null,
    });

    expect(afterDiffSave.dynamic.effective.reviewVerdict).toBe("off");
    expect(cleared.dynamic.effective.reviewVerdict).toBe("blocking");
    expect(cleared.dynamic.sources.reviewVerdict).toBe("built_in");
    expect((await app.projects.get(app.first.id))?.settings).toEqual({
      maxFindings: 3,
    });
  });

  // #405-T28
  it("refuse an unknown verdict mode, name the field and store nothing", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        reviewVerdict: "always",
      }),
    );

    expect(error.code).toBe("REVIEW_SETTINGS_INVALID");
    expect(error.issues).toEqual([
      { field: "reviewVerdict", code: "INVALID_FORMAT" },
    ]);
    expect((await app.projects.get(app.first.id))?.settings).toEqual({});
  });

  // #405-T28
  it("clear the verdict mode with the rest when the project is reset, and read an unknown stored one as the default", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "any",
    });

    const reset = await app.service.resetProjectSettings(app.first.id);
    await app.projects.updateSettings(app.first.id, {
      reviewVerdict: "sometimes",
    });
    const stored = await app.service.getProjectSettings(app.first.id);

    expect(reset.dynamic.effective.reviewVerdict).toBe("blocking");
    expect(stored.dynamic.effective.reviewVerdict).toBe("blocking");
  });

  // #194-T06
  it("keep the project-only fields when an ordinary Diff-only save replaces the Diff set", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: "qwen/qwen3-coder",
      maxFindings: 2,
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "Review for the Dynamic kind.",
    });

    const view = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 3,
    });

    expect(view.overrides).toEqual({ maxFindings: 3 });
    expect(view.dynamic.overrides).toEqual({
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "Review for the Dynamic kind.",
    });
    expect((await app.projects.get(app.first.id))?.settings).toEqual({
      maxFindings: 3,
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "Review for the Dynamic kind.",
    });
  });

  // #194-T06
  it("reset only the skill override and keep the kind, the model and the Diff overrides", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: "qwen/qwen3-coder",
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "Review for the Dynamic kind.",
    });

    const view = await app.service.updateProjectSettings(app.first.id, {
      model: "qwen/qwen3-coder",
      reviewSkill: "",
    });

    expect(view.dynamic.reviewSkillIsDefault).toBe(true);
    expect(view.dynamic.effective.reviewSkill).toBe(TEST_DEFAULT_SKILL.text);
    expect(view.dynamic.overrides.reviewSkill).toBeUndefined();
    expect(view.dynamic.overrides.reviewKind).toBe("dynamic");
    expect(view.dynamic.overrides.dynamicModel).toBe("vendor/dynamic-model");
    expect(view.effective.model).toBe("qwen/qwen3-coder");
  });

  // #200 review: the model has the same `null` reset as the skill.
  it("reset only the Dynamic model override and keep the kind, the skill and the Diff overrides", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: "qwen/qwen3-coder",
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "Review for the Dynamic kind.",
    });
    const saved = await app.service.getProjectSettings(app.first.id);
    expect(saved.dynamic.overrides.dynamicModel).toBe("vendor/dynamic-model");

    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: null,
    });

    expect(view.dynamic.sources.dynamicModel).toBe("built_in");
    expect(view.dynamic.effective.dynamicModel).toBe(DEFAULT_DYNAMIC_MODEL);
    expect(view.dynamic.overrides.dynamicModel).toBeUndefined();
    expect(view.dynamic.overrides.reviewKind).toBe("dynamic");
    expect(view.dynamic.overrides.reviewSkill).toBe(
      "Review for the Dynamic kind.",
    );
    expect(view.effective.model).toBe("qwen/qwen3-coder");
  });

  // #194-T06
  it("a full reset clears the project-only settings and returns to Diff Review", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
      reviewSkill: "Review for the Dynamic kind.",
    });

    const view = await app.service.resetProjectSettings(app.first.id);

    expect(view.overrides).toEqual({});
    expect(view.dynamic.overrides).toEqual({});
    expect(view.dynamic.effective.reviewKind).toBe("diff");
    expect(view.dynamic.effective.dynamicModel).toBe(DEFAULT_DYNAMIC_MODEL);
    expect(view.dynamic.reviewSkillIsDefault).toBe(true);
  });

  // #194-T06
  it("cannot be broken by stored project-only data this version would not accept", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.projects.updateSettings(app.first.id, {
      reviewKind: "auto",
      dynamicModel: "bad model",
      reviewSkill: "rule\u0000x",
    });

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.dynamic.overrides).toEqual({});
    expect(view.dynamic.effective.reviewKind).toBe("diff");
    expect(view.dynamic.effective.dynamicModel).toBe(DEFAULT_DYNAMIC_MODEL);
  });
});

describe("a project settings change that fails", () => {
  // #194-T07
  it("rolls the write back when the settings-change hook rejects, leaving no partial change", async () => {
    const app = await setupReviewSettings(undefined, {
      hooks: {
        onProjectSettingsChanged: async () => {
          throw new Error("settings hook failed");
        },
      },
    });
    await app.projects.activate(app.first.id);
    await app.projects.updateSettings(app.first.id, { maxFindings: 2 });

    await expect(
      app.service.updateProjectSettings(app.first.id, {
        maxFindings: 9,
        reviewKind: "dynamic",
      }),
    ).rejects.toThrow("settings hook failed");

    expect((await app.projects.get(app.first.id))?.settings).toEqual({
      maxFindings: 2,
    });
  });
});

// #194-T03, #194-T06: the Diff settings and the project-only settings are independent. A request
// that only touches the kind, the Dynamic model or the skill must not remove the Diff overrides.
describe("keeping the Diff settings across a project-only change", () => {
  // #194-T03
  it("keep the stored Diff overrides when a request only changes the kind and the Dynamic model", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: "vendor/diff",
      maxFindings: 2,
    });

    const view = await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/new",
    });

    expect(view.effective.model).toBe("vendor/diff");
    expect(view.effective.maxFindings).toBe(2);
    expect(view.dynamic.effective.reviewKind).toBe("dynamic");
    expect(view.dynamic.effective.dynamicModel).toBe("vendor/new");
    expect((await app.projects.get(app.first.id))?.settings).toEqual({
      model: "vendor/diff",
      maxFindings: 2,
      reviewKind: "dynamic",
      dynamicModel: "vendor/new",
    });
  });

  // #194-T06
  it("reset only the skill override without resending the Diff fields", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: "vendor/diff",
      maxFindings: 2,
      reviewKind: "dynamic",
      dynamicModel: "vendor/model",
      reviewSkill: "Review for the Dynamic kind.",
    });

    const view = await app.service.updateProjectSettings(app.first.id, {
      reviewSkill: "",
    });

    expect(view.dynamic.reviewSkillIsDefault).toBe(true);
    expect(view.dynamic.overrides.reviewSkill).toBeUndefined();
    expect(view.dynamic.effective.reviewKind).toBe("dynamic");
    expect(view.effective.model).toBe("vendor/diff");
    expect(view.effective.maxFindings).toBe(2);
  });

  // #194-T06
  it("do not let a stale form overwrite a newer project-only value", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: "vendor/diff",
      dynamicModel: "vendor/old",
    });
    // Another client changes the Dynamic model.
    await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/new",
    });

    // The stale form only sends the Diff fields it knows; it never resends the Dynamic settings.
    const view = await app.service.updateProjectSettings(app.first.id, {
      model: "vendor/diff",
      maxFindings: 3,
    });

    expect(view.dynamic.effective.dynamicModel).toBe("vendor/new");
    expect(view.effective.model).toBe("vendor/diff");
    expect(view.effective.maxFindings).toBe(3);
  });
});

// #194-T07: a full reset runs the settings-change hook inside the reset transaction, so a kind
// change back to Diff is announced and a rejecting hook rolls the reset back.
describe("a full reset and the settings-change hook", () => {
  it("announce a reset of a Dynamic project as a kind change back to Diff", async () => {
    const events: Array<{
      previousKind: string;
      nextKind: string;
      kindChanged: boolean;
    }> = [];
    const app = await setupReviewSettings(undefined, {
      hooks: {
        onProjectSettingsChanged: async (event) => {
          events.push({
            previousKind: event.previousKind,
            nextKind: event.nextKind,
            kindChanged: event.kindChanged,
          });
        },
      },
    });
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/model",
    });
    events.length = 0;

    const view = await app.service.resetProjectSettings(app.first.id);

    expect(view.dynamic.effective.reviewKind).toBe("diff");
    expect(events).toEqual([
      { previousKind: "dynamic", nextKind: "diff", kindChanged: true },
    ]);
  });

  it("roll the reset back when the hook rejects, leaving the stored settings", async () => {
    let failing = false;
    const app = await setupReviewSettings(undefined, {
      hooks: {
        onProjectSettingsChanged: async () => {
          if (failing) throw new Error("settings hook failed");
        },
      },
    });
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: "vendor/diff",
      reviewKind: "dynamic",
      dynamicModel: "vendor/model",
    });

    failing = true;
    await expect(
      app.service.resetProjectSettings(app.first.id),
    ).rejects.toThrow("settings hook failed");

    expect((await app.projects.get(app.first.id))?.settings).toEqual({
      model: "vendor/diff",
      reviewKind: "dynamic",
      dynamicModel: "vendor/model",
    });
  });
});

// #283: a workspace on the operator's key chooses a quality level; the models are not its business.
describe("the settings of a workspace on the operator's key", () => {
  const OWN_MODEL = "acme-own/model-9";
  const OWN_FALLBACK = "acme-own/fallback-3";
  const OWN_DYNAMIC = "acme-own/dynamic-5";

  /** Every key name in a JSON value, at any depth. */
  function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value).flatMap(([key, entry]) => [
      key,
      ...keysOf(entry),
    ]);
  }

  async function managedWorkspace() {
    const app = await setupReviewSettings(undefined, {
      operatorsModels: true,
    });
    await app.projects.activate(app.first.id);
    return app;
  }

  // #283-T01
  it("shows no model, in the workspace defaults and in a project", async () => {
    const app = await managedWorkspace();

    const global = await app.service.getGlobalSettings();
    const project = await app.service.getProjectSettings(app.first.id);

    for (const view of [global, project]) {
      expect(view.modelManagedByInstance).toBe(true);
      expect(view.effective).not.toHaveProperty("model");
      expect(view.effective).not.toHaveProperty("fallbackModel");
      expect(view.cost).toBeNull();
    }
    expect(project.dynamic.effective).not.toHaveProperty("dynamicModel");
    expect(project.dynamic.defaults).not.toHaveProperty("dynamicModel");
    expect(global).not.toHaveProperty("builtIn.model");
    expect(project.inherited).not.toHaveProperty("model");
  });

  // #283-T07
  it("holds no model field and no model name anywhere in the answer", async () => {
    const app = await managedWorkspace();
    const global = await app.service.getGlobalSettings();
    const project = await app.service.getProjectSettings(app.first.id);

    for (const view of [global, project]) {
      const text = JSON.stringify(view);
      expect(keysOf(view)).not.toContain("model");
      expect(keysOf(view)).not.toContain("fallbackModel");
      expect(keysOf(view)).not.toContain("dynamicModel");
      for (const name of [TEST_MODEL, DEFAULT_DYNAMIC_MODEL])
        expect(text).not.toContain(name);
    }
  });

  // #283-T04
  it.each([
    ["model", { model: "acme-x/y-1" }],
    ["fallbackModel", { fallbackModel: "acme-x/y-1" }],
    ["fallbackModel", { fallbackModel: null }],
  ])(
    "refuses %s in a write to the workspace defaults with MODEL_MANAGED_BY_INSTANCE and stores nothing",
    async (field, body) => {
      const app = await managedWorkspace();

      const error = await refusal(
        app.service.updateGlobalSettings({ ...body }, "octocat"),
      );

      expect(error.code).toBe("REVIEW_SETTINGS_INVALID");
      expect(error.issues).toEqual([
        { field, code: "MODEL_MANAGED_BY_INSTANCE" },
      ]);
      expect(await app.appSettingRows()).toEqual([]);
    },
  );

  // #283-T04
  it.each([
    ["model", { model: "acme-x/y-1" }],
    ["fallbackModel", { fallbackModel: "acme-x/y-1" }],
    ["dynamicModel", { dynamicModel: "acme-x/y-1" }],
    ["dynamicModel", { dynamicModel: null }],
  ])(
    "refuses %s in a write to a project with MODEL_MANAGED_BY_INSTANCE and stores nothing",
    async (field, body) => {
      const app = await managedWorkspace();

      const error = await refusal(
        app.service.updateProjectSettings(app.first.id, { ...body }),
      );

      expect(error.issues).toEqual([
        { field, code: "MODEL_MANAGED_BY_INSTANCE" },
      ]);
      expect((await app.projects.get(app.first.id))?.settings).toEqual({});
    },
  );

  // #283-T04
  it("names every model field of one write, not only the first", async () => {
    const app = await managedWorkspace();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        model: "acme-x/y-1",
        dynamicModel: "acme-x/y-2",
        maxFindings: 3,
      }),
    );

    expect(error.issues).toEqual([
      { field: "model", code: "MODEL_MANAGED_BY_INSTANCE" },
      { field: "dynamicModel", code: "MODEL_MANAGED_BY_INSTANCE" },
    ]);
  });

  // #283-T02
  it("still takes a model from a workspace on its own key, and an unknown field stays unknown", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);

    const view = await app.service.updateProjectSettings(app.first.id, {
      model: "acme-x/y-1",
      dynamicModel: "acme-x/y-2",
    });

    expect(view.modelManagedByInstance).toBe(false);
    expect(view.effective.model).toBe("acme-x/y-1");
    expect(view.dynamic.effective.dynamicModel).toBe("acme-x/y-2");
    expect(view.cost).not.toBeNull();
  });

  // #283-T01
  it("keeps the models a workspace saved on its own key through a save of another setting, and gives them back on its own key", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings(
      { model: OWN_MODEL, fallbackModel: OWN_FALLBACK, maxFindings: 4 },
      "octocat",
    );
    await app.service.updateProjectSettings(app.first.id, {
      model: OWN_MODEL,
      dynamicModel: OWN_DYNAMIC,
      maxFindings: 6,
    });
    app.setOperatorsModels(true);

    const global = await app.service.updateGlobalSettings(
      { maxFindings: 5 },
      "octocat",
    );
    const project = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 7,
    });

    expect(JSON.stringify([global, project])).not.toContain(OWN_MODEL);
    expect(JSON.stringify([global, project])).not.toContain(OWN_DYNAMIC);
    app.setOperatorsModels(false);
    const back = await app.service.getProjectSettings(app.first.id);
    expect(back.overrides).toMatchObject({
      model: OWN_MODEL,
      maxFindings: 7,
    });
    expect(back.dynamic.overrides.dynamicModel).toBe(OWN_DYNAMIC);
    expect((await app.service.getGlobalSettings()).overrides).toMatchObject({
      model: OWN_MODEL,
      fallbackModel: OWN_FALLBACK,
      maxFindings: 5,
    });
  });

  // #283-T01
  it("keeps the models of its own key through a reset of the project, and drops the rest of the overrides", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: OWN_MODEL,
      fallbackModel: OWN_FALLBACK,
      dynamicModel: OWN_DYNAMIC,
      maxFindings: 9,
      reviewKind: "dynamic",
    });
    app.setOperatorsModels(true);

    const reset = await app.service.resetProjectSettings(app.first.id);

    expect(JSON.stringify(reset)).not.toContain("acme-own");
    expect(reset.overrides).not.toHaveProperty("maxFindings");
    expect(reset.dynamic.effective.reviewKind).toBe("diff");
    expect((await app.projects.get(app.first.id))?.settings).toEqual({
      model: OWN_MODEL,
      fallbackModel: OWN_FALLBACK,
      dynamicModel: OWN_DYNAMIC,
    });
  });

  // #283-T07
  it("does not show a stored model of the workspace while the operator's key is used", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, {
      model: OWN_MODEL,
      dynamicModel: OWN_DYNAMIC,
    });
    app.setOperatorsModels(true);

    const project = await app.service.getProjectSettings(app.first.id);

    expect(JSON.stringify(project)).not.toContain(OWN_MODEL);
    expect(JSON.stringify(project)).not.toContain(OWN_DYNAMIC);
    expect(project.overrides).not.toHaveProperty("model");
  });
});
