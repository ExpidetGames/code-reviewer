// SPDX-License-Identifier: Apache-2.0

// Saving the models of the Anthropic provider (#532): what the form suggests for a kind is accepted when it is saved
// (as the pair of provider and model), and a model that cannot serve a Dynamic Review is refused on its field. The
// adapter answers from its own list, so no network is involved.
import { describe, expect, it } from "vitest";
import { createModelCapabilityChecker } from "../llm/model-capabilities.ts";
import { anthropicDescriptor } from "../llm/providers/anthropic/descriptor.ts";
import { ANTHROPIC_MODELS } from "../llm/providers/anthropic/models.ts";
import { suggestedModelsFor } from "../llm/providers/suggested-models.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import { ReviewSettingsError } from "./errors.ts";

async function start() {
  const modelCapabilities = createModelCapabilityChecker({
    baseUrl: () => "http://127.0.0.1:1",
    log: () => undefined,
    timeoutMs: 500,
  });
  const app = await setupReviewSettings(undefined, { modelCapabilities });
  await app.projects.activate(app.first.id);
  return app;
}

describe("saving a project with the Anthropic provider", () => {
  // #532-T05
  it("accepts every model suggested for Dynamic Review as the Dynamic model, and keeps the pair", async () => {
    const app = await start();
    for (const model of suggestedModelsFor(anthropicDescriptor, "dynamic")) {
      const view = await app.service.updateProjectSettings(app.first.id, {
        reviewKind: "dynamic",
        dynamicProvider: "anthropic",
        dynamicModel: model,
      });
      expect(view.dynamic.effective, model).toMatchObject({
        reviewKind: "dynamic",
        dynamicProvider: "anthropic",
        dynamicModel: model,
      });
    }
  });

  // #532-T05
  it("accepts every model suggested for Diff Review as the Diff model", async () => {
    const app = await start();
    for (const model of suggestedModelsFor(anthropicDescriptor, "diff")) {
      const view = await app.service.updateProjectSettings(app.first.id, {
        provider: "anthropic",
        model,
      });
      expect(view.effective, model).toMatchObject({
        provider: "anthropic",
        model,
      });
    }
  });

  // #532-T05
  it("refuses a model whose list entry lacks Dynamic Review on the Dynamic model, and stores nothing", async () => {
    const app = await start();
    // Derived from the list: since #533 every model serves a Dynamic Review, so the loop is empty until a model of the
    // list leaves the kind out again; then this test covers it without an edit.
    const refused = ANTHROPIC_MODELS.filter(
      (model) => !model.reviewKinds.includes("dynamic"),
    );

    for (const { id } of refused) {
      const error = await app.service
        .updateProjectSettings(app.first.id, {
          dynamicProvider: "anthropic",
          dynamicModel: id,
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error, id).toBeInstanceOf(ReviewSettingsError);
      expect((error as ReviewSettingsError).issues, id).toEqual([
        { field: "dynamicModel", code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED" },
      ]);
    }
    // The project row exists (it was activated) and holds no settings.
    expect((await app.projectRows()).map((row) => row.settings)).toEqual([
      "{}",
    ]);
  });
});
