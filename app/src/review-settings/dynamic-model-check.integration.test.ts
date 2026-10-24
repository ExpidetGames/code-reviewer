// SPDX-License-Identifier: LicenseRef-Proprietary

// Saving a Dynamic model asks the provider's model metadata whether it supports tool calling (#269): an
// unsupported or unknown model is refused on its field and nothing is stored, a provider that cannot be asked
// lets the save through with a warning, a supported answer is remembered for a short time. The Diff model and
// values already stored are never checked. The metadata comes from the fake LLM over real HTTP.
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { createFakeAdapter } from "../llm/providers/fake-adapter.ts";
import { anthropicAdapter } from "../llm/providers/anthropic/adapter.ts";
import { openrouterAdapter } from "../llm/providers/openrouter/adapter.ts";
import { createAdapterRegistry } from "../llm/providers/registry.ts";
import type {
  ModelCapabilities,
  ModelCapabilityResult,
} from "../llm/providers/types.ts";
import {
  createModelCapabilityChecker,
  type ModelCapabilityChecker,
} from "../llm/model-capabilities.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import { ReviewSettingsError } from "./errors.ts";

const TOOLS = { supported_parameters: ["tools", "tool_choice"] };

async function setup(options: { baseUrl?: string } = {}) {
  const llm = await startLlmFake();
  cleanUpAfterTest(() => llm.close());
  const modelCapabilities: ModelCapabilityChecker =
    createModelCapabilityChecker({
      baseUrl: () => options.baseUrl ?? llm.baseUrl,
      log: () => undefined,
      timeoutMs: 1000,
    });
  const app = await setupReviewSettings(undefined, { modelCapabilities });
  return { ...app, llm };
}

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

describe("saving a Dynamic model", () => {
  // #269-T05
  it("refuses a model without tool support on the field and stores nothing", async () => {
    const app = await setup();
    app.llm.setModel("vendor/no-tools", [
      { supported_parameters: ["tools", "temperature"] },
    ]);

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicModel: "vendor/no-tools",
        reviewKind: "dynamic",
      }),
    );

    expect(error.code).toBe("REVIEW_SETTINGS_INVALID");
    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED" },
    ]);
    expect(await app.projectRows()).toEqual([]);
  });

  // #269-T06
  it("refuses a model the provider does not know", async () => {
    const app = await setup();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicModel: "vendor/not-a-model",
      }),
    );

    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "DYNAMIC_MODEL_UNKNOWN" },
    ]);
    expect(await app.projectRows()).toEqual([]);
  });

  it("stores a supported model without a warning", async () => {
    const app = await setup();
    app.llm.setModel("vendor/good", [TOOLS]);

    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/good",
    });

    expect(view.dynamic.effective.dynamicModel).toBe("vendor/good");
    expect(view.warnings).toEqual([]);
  });

  // #269-T07
  it("accepts the save with a warning when the metadata cannot be reached", async () => {
    const app = await setup({ baseUrl: "http://127.0.0.1:1/api/v1" });

    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/whatever",
    });

    expect(view.dynamic.effective.dynamicModel).toBe("vendor/whatever");
    expect(view.warnings).toEqual([
      { field: "dynamicModel", code: "DYNAMIC_MODEL_UNVERIFIED" },
    ]);
  });

  // #269-T08
  it("asks the provider once when the same supported model is saved twice", async () => {
    const app = await setup();
    app.llm.setModel("vendor/good", [TOOLS]);

    await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/good",
    });
    await app.service.updateProjectSettings(app.second.id, {
      dynamicModel: "vendor/good",
    });
    await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/good",
      reviewKind: "dynamic",
    });

    expect(app.llm.modelRequests()).toHaveLength(1);
    expect(app.llm.modelRequests()[0]?.authorization).toBe("");
  });

  // #269-T08
  it("sees a model that gained tool support at the next try", async () => {
    const app = await setup();
    app.llm.setModel("vendor/later", [{ supported_parameters: ["tools"] }]);
    await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicModel: "vendor/later",
      }),
    );

    app.llm.setModel("vendor/later", [TOOLS]);
    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/later",
    });

    expect(view.dynamic.effective.dynamicModel).toBe("vendor/later");
  });
});

describe("what is not checked", () => {
  // #269-T09
  it("does not check the Diff model, the fallback model or the global defaults", async () => {
    const app = await setup();

    await app.service.updateProjectSettings(app.first.id, {
      model: "vendor/no-tools",
      fallbackModel: "vendor/also-no-tools",
    });
    await app.service.updateGlobalSettings(
      { model: "vendor/global-no-tools" },
      "octocat",
    );

    expect(app.llm.modelRequests()).toEqual([]);
  });

  // #269-T09
  it("does not check a save that clears the Dynamic model or leaves it out", async () => {
    const app = await setup();
    app.llm.setModel("vendor/good", [TOOLS]);
    await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/good",
    });
    const asked = app.llm.modelRequests().length;

    await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
    });
    const cleared = await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: null,
    });

    expect(app.llm.modelRequests()).toHaveLength(asked);
    expect(cleared.warnings).toEqual([]);
  });

  // #269-T09
  it("leaves a model that is already stored alone, even if it would not pass now", async () => {
    const app = await setup();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      dynamicModel: "vendor/stored-before",
      reviewKind: "dynamic",
    }));

    const view = await app.service.updateProjectSettings(app.first.id, {
      reviewSkill: "A skill.",
    });
    const reset = await app.service.getProjectSettings(app.first.id);

    expect(view.dynamic.effective.dynamicModel).toBe("vendor/stored-before");
    expect(reset.dynamic.effective.dynamicModel).toBe("vendor/stored-before");
    expect(app.llm.modelRequests()).toEqual([]);
  });
});

// #430-T11: the check asks the adapter of the provider the project selected, not the default provider's.
describe("saving a Dynamic model at a provider the project selected", () => {
  const CAPABILITIES: ModelCapabilities = {
    tools: true,
    toolChoice: true,
    toolChoiceRequired: true,
    responseFormat: false,
    structuredOutputs: false,
    maxCompletionTokens: null,
    smallestCompletionTokens: null,
    contextLength: null,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
  };
  const SUPPORTED: ModelCapabilityResult = {
    outcome: "supported",
    capabilities: CAPABILITIES,
  };
  const UNSUPPORTED: ModelCapabilityResult = {
    outcome: "unsupported",
    capabilities: { ...CAPABILITIES, toolChoice: false },
  };

  async function setupTwoProviders() {
    const asked: string[] = [];
    const registry = createAdapterRegistry([
      openrouterAdapter,
      createFakeAdapter({
        checkModelCapabilities: async ({ modelId }) => {
          asked.push(modelId);
          return modelId === "fake-bad" ? UNSUPPORTED : SUPPORTED;
        },
      }),
    ]);
    const modelCapabilities = createModelCapabilityChecker({
      adapters: registry,
      baseUrl: (provider) => registry.get(provider).apiBaseUrl,
      log: () => undefined,
    });
    const app = await setupReviewSettings(undefined, {
      modelCapabilities,
      providers: registry,
    });
    return { ...app, asked };
  }

  // #430-T11
  it("asks the adapter of the selected provider about the model", async () => {
    const app = await setupTwoProviders();

    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: "fakeai",
      dynamicModel: "fake-large",
    });

    expect(app.asked).toEqual(["fake-large"]);
    expect(view.warnings).toEqual([]);
    expect(view.dynamic.effective.dynamicProvider).toBe("fakeai");
  });

  // #430-T11
  it("refuses a model that the selected provider's adapter reports without tool support", async () => {
    const app = await setupTwoProviders();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "fakeai",
        dynamicModel: "fake-bad",
      }),
    );

    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED" },
    ]);
    expect(await app.projectRows()).toEqual([]);
  });

  // #430-T11
  it("asks again at the new provider when only the provider of a stored model changes", async () => {
    const app = await setupTwoProviders();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      dynamicModel: "fake-bad",
    }));

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "fakeai",
      }),
    );

    expect(app.asked).toEqual(["fake-bad"]);
    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED" },
    ]);
  });

  // #533-T17: the four models that took no forced tool choice or could not run without thinking were refused at
  // the save (`DYNAMIC_MODEL_TOOLS_UNSUPPORTED`); the runner steers them now, so the list is the answer.
  it.each([
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-fable-5",
  ])(
    "saves %s as the Dynamic model of the Anthropic provider",
    async (model) => {
      const registry = createAdapterRegistry([
        openrouterAdapter,
        anthropicAdapter,
      ]);
      const modelCapabilities = createModelCapabilityChecker({
        adapters: registry,
        baseUrl: (provider) => registry.get(provider).apiBaseUrl,
        log: () => undefined,
      });
      const app = await setupReviewSettings(undefined, {
        modelCapabilities,
        providers: registry,
      });

      const view = await app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "anthropic",
        dynamicModel: model,
      });

      expect(view.warnings).toEqual([]);
      expect(view.dynamic.effective.dynamicModel).toBe(model);
    },
  );
});
