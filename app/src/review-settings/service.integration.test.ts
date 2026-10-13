// SPDX-License-Identifier: Apache-2.0

// Pins down the review settings service against a real SQLite file: the global defaults and the
// overrides of a project are two layers that are combined when they are read, a change of the global
// defaults reaches every project that does not override the field, resetting an override brings the
// project back to the global value, bad input is refused with the affected fields and stores nothing,
// and stored data that is no longer valid cannot break a review.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { ReviewSettingsError } from "./errors.ts";
import {
  setupReviewSettings,
  TEST_MODEL,
} from "../test-support/review-settings-harness.ts";
import { DEFAULT_MAX_TOKENS } from "./settings.ts";

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

describe("the global defaults", () => {
  it("are the built-in values until somebody saves some, with the model of the instance", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.getGlobalSettings();

    expect(view.overrides).toEqual({});
    expect(view.effective.model).toBe(TEST_MODEL);
    expect(view.effective.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(view.effective.largePrChunking).toBe(true);
    expect(view.updatedAt).toBeNull();
    expect(Object.values(view.sources)).toEqual(
      Object.values(view.sources).map(() => "built_in"),
    );
    expect(view.cost.warn).toBe(false);
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
      { maxFindings: 8, maxTokens: 50_000 },
      "octocat",
    );

    const view = await app.service.updateGlobalSettings(
      { maxTokens: 60_000 },
      "hubot",
    );

    expect(view.overrides).toEqual({ maxTokens: 60_000 });
    expect(view.effective.maxFindings).toBe(5);
    expect(view.updatedBy).toBe("hubot");
  });

  // #178 review M2: the "Reset every default" danger zone sends an empty patch; it must clear the global
  // layer and leave the overrides of a project alone.
  it("clear every global override with an empty patch, and keep a project's own overrides", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings(
      { maxFindings: 8, maxTokens: 50_000 },
      "octocat",
    );
    await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 3,
      maxTokens: 70_000,
    });

    const view = await app.service.updateGlobalSettings({}, "hubot");

    expect(view.overrides).toEqual({});
    expect(view.effective.maxFindings).toBe(5);
    expect(view.effective.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(view.updatedBy).toBe("hubot");
    expect(await app.appSettingRows()).toMatchObject([
      { key: "review_defaults", value: "{}", updated_by: "hubot" },
    ]);
    const project = await app.service.getProjectSettings(app.first.id);
    expect(project.overrides).toEqual({ maxFindings: 3, maxTokens: 70_000 });
    expect(project.effective.maxFindings).toBe(3);
    expect(project.effective.maxTokens).toBe(70_000);
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

    expect(view.cost.warn).toBe(true);
    expect(view.cost.primary).toMatchObject({
      status: "estimated",
      aboveLimit: true,
    });
    expect(view.effective.model).toBe("anthropic/claude-opus-5.5");
  });
});

describe("the token budget against the context window of the model", () => {
  // deepseek/deepseek-v3.2 has a context window of 163,840 tokens in the price table
  it("refuses a global budget that does not fit into the model, blaming the budget", async () => {
    const app = await setupReviewSettings();

    const error = await refusal(
      app.service.updateGlobalSettings({ maxTokens: 1_000_000 }, "octocat"),
    );

    expect(error.issues).toEqual([
      { field: "maxTokens", code: "EXCEEDS_MODEL_CONTEXT" },
    ]);
    expect(await app.appSettingRows()).toEqual([]);
  });

  it("accepts the same budget together with a model that has the room", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.updateGlobalSettings(
      { maxTokens: 500_000, model: "anthropic/claude-haiku-5.5" },
      "octocat",
    );

    expect(view.effective.maxTokens).toBe(500_000);
    expect(view.cost.exceedsContext).toEqual([]);
  });

  it("refuses a model that is too small for the budget in effect and blames the model", async () => {
    const app = await setupReviewSettings();
    await app.service.updateGlobalSettings(
      { maxTokens: 500_000, model: "anthropic/claude-haiku-5.5" },
      "octocat",
    );
    await app.projects.activate(app.first.id);

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        model: "deepseek/deepseek-v3.2",
      }),
    );

    expect(error.issues).toEqual([
      { field: "model", code: "EXCEEDS_MODEL_CONTEXT" },
    ]);
  });

  it("does not know a model the table does not know, so it cannot refuse the budget for it", async () => {
    const app = await setupReviewSettings();

    const view = await app.service.updateGlobalSettings(
      { model: "some/new-model", maxTokens: 2_000_000 },
      "octocat",
    );

    expect(view.effective.maxTokens).toBe(2_000_000);
    expect(view.cost.warnings).toEqual([
      { model: "primary", kind: "cost_unknown" },
    ]);
  });

  it("shows a combination that a later change made too large without blaming an unrelated save", async () => {
    const app = await setupReviewSettings();
    await app.projects.activate(app.first.id);
    await app.service.updateGlobalSettings(
      { model: "anthropic/claude-haiku-5.5" },
      "octocat",
    );
    await app.service.updateProjectSettings(app.first.id, {
      maxTokens: 600_000,
    });

    await app.service.updateGlobalSettings(
      { model: "deepseek/deepseek-v3.2" },
      "octocat",
    );
    const view = await app.service.getProjectSettings(app.first.id);
    const saved = await app.service
      .updateProjectSettings(app.first.id, {
        maxTokens: 600_000,
        maxFindings: 3,
      })
      .catch((error: unknown) => error);

    expect(view.cost.exceedsContext).toEqual(["primary"]);
    // A save that sets the budget again is asked to fix it.
    expect(saved).toBeInstanceOf(ReviewSettingsError);
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
      maxTokens: DEFAULT_MAX_TOKENS,
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
      maxTokens: 50_000,
    });

    const view = await app.service.updateProjectSettings(app.first.id, {
      maxFindings: 3,
    });

    expect(view.overrides).toEqual({ maxFindings: 3 });
    expect(view.effective.maxTokens).toBe(DEFAULT_MAX_TOKENS);
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

    for (const call of [
      app.service.getProjectSettings("no-such-repository"),
      app.service.updateProjectSettings("no-such-repository", {
        maxFindings: 2,
      }),
      app.service.resetProjectSettings("no-such-repository"),
    ])
      expect((await refusal(call)).code).toBe(
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
      { maxTokens: "lots", inlineKeyIssues: true },
      null,
    );

    const view = await app.service.getProjectSettings(app.first.id);

    expect(view.overrides).toEqual({ model: "qwen/qwen3-coder" });
    expect(view.effective).toMatchObject({
      model: "qwen/qwen3-coder",
      maxFindings: 5,
      maxTokens: DEFAULT_MAX_TOKENS,
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
