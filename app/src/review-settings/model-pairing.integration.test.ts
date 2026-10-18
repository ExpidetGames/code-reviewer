// SPDX-License-Identifier: Apache-2.0

// #432: a project provider next to a workspace model of another provider is refused when the settings are saved, with
// the rule the claim applies (`modelProviderMismatch`), and the layers the claim resolves a model from are handed on
// as they were written (`resolveForRepository`).
import { describe, expect, it } from "vitest";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "../llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../llm/providers/registry.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  createCatalogFixture,
  setupReviewSettings,
} from "../test-support/review-settings-harness.ts";
import { ReviewSettingsError } from "./errors.ts";
import type { ReviewSettingIssue } from "./validate.ts";

const TWO_PROVIDERS = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);
const DEFAULT_PROVIDER = openrouterDescriptor.id;
const DEFAULT_MODEL = "vendor/default-model";

async function issuesOf(
  promise: Promise<unknown>,
): Promise<{ code: string; issues: readonly ReviewSettingIssue[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReviewSettingsError)
      return { code: error.code, issues: error.issues };
    throw error;
  }
  throw new Error("expected the call to be refused");
}

async function start(options: { managed?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const catalog = createCatalogFixture(db);
  const app = await setupReviewSettings(db, {
    operatorsModels: options.managed === true,
    catalog: catalog.source,
    providers: TWO_PROVIDERS,
  });
  await app.projects.activate(app.first.id);
  return app;
}

describe("the project provider and the workspace model of another provider", () => {
  // #432-T17
  it("is refused when the project is saved, and nothing is written", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      "a",
    );
    const before = await app.projectRows();

    const refused = await issuesOf(
      app.service.updateProjectSettings(app.first.id, {
        provider: DEFAULT_PROVIDER,
      }),
    );

    expect(refused).toEqual({
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "provider", code: "MODEL_PROVIDER_MISMATCH" }],
    });
    expect(await app.projectRows()).toEqual(before);
  });

  // #432-T17
  it("is accepted when the same save brings a model of the new provider", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      "a",
    );

    await app.service.updateProjectSettings(app.first.id, {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });

    expect((await app.projects.get(app.first.id))?.settings).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
  });

  // #432-T17
  it("is refused when the workspace default changes under a project that inherits its model", async () => {
    const app = await start();
    await app.service.updateProjectSettings(app.first.id, {
      provider: DEFAULT_PROVIDER,
    });
    const before = await app.appSettingRows();

    const refused = await issuesOf(
      app.service.updateGlobalSettings(
        { provider: FAKE_PROVIDER_ID, model: "fake-large" },
        "a",
      ),
    );

    expect(refused.code).toBe("REVIEW_SETTINGS_INVALID");
    expect(refused.issues).toEqual([
      { field: "model", code: "MODEL_PROVIDER_MISMATCH" },
    ]);
    expect(await app.appSettingRows()).toEqual(before);
  });

  // #432-T17
  it("does not stop a workspace default change for a project that already had the pairing before it", async () => {
    const app = await start();
    // The pairing is stored by an earlier release, which did not check it.
    await app.appSettings.set(
      "review_defaults",
      { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      "a",
    );
    await app.projects.updateSettings(app.first.id, {
      provider: DEFAULT_PROVIDER,
    });

    await app.service.updateGlobalSettings(
      { provider: FAKE_PROVIDER_ID, model: "fake-small" },
      "a",
    );

    expect((await app.service.getGlobalSettings()).overrides).toMatchObject({
      model: "fake-small",
    });
  });

  // #432-T17
  it("is not checked for a workspace on the operator's key, which selects entries and not providers", async () => {
    const app = await start({ managed: true });

    await expect(
      app.service.updateProjectSettings(app.first.id, { maxFindings: 3 }),
    ).resolves.toBeDefined();
  });
});

describe("the layers the claim resolves a model from", () => {
  // #432-T01
  it("are handed on as written: the workspace default and the project apart", async () => {
    const app = await start();
    await app.service.updateGlobalSettings(
      { provider: FAKE_PROVIDER_ID, model: "fake-large" },
      "a",
    );
    await app.service.updateProjectSettings(app.first.id, {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
    await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/dynamic-model",
    });

    const resolved = await app.service.resolveForRepository(app.first.id);

    expect(resolved?.modelLayers).toEqual({
      diff: {
        workspace: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
        project: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
      },
      dynamic: {
        project: { model: "vendor/dynamic-model" },
      },
    });
  });

  // #432-T01
  it("leave out what no layer set, so the claim applies the built-in model and the default provider", async () => {
    const app = await start();

    const resolved = await app.service.resolveForRepository(app.first.id);

    expect(resolved?.modelLayers.diff.workspace).toEqual({});
    expect(resolved?.modelLayers.diff.project).toEqual({});
    expect(resolved?.modelLayers.dynamic.project).toEqual({});
  });
});
