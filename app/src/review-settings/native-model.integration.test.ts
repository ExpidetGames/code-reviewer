// SPDX-License-Identifier: Apache-2.0

// Saving the Dynamic provider and model of a project with a catalog provider (#555): the model must be in the catalog; a model
// the catalog does not hold, or no longer lists, is refused with `MODEL_NOT_IN_CATALOG` on its field and nothing is stored.
// The Diff model is not offered the catalog (#558). The provider's own model metadata is not asked: the catalog is the list.
import { describe, expect, it } from "vitest";
import type {
  NativeCatalogReader,
  NativeChoice,
} from "../native-providers/catalog.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import { ReviewSettingsError } from "./errors.ts";

const LISTED = new Set(["deepseek/deepseek-v4-pro", "openai/gpt-5.5"]);

function catalog(
  asked: string[] = [],
): Pick<NativeCatalogReader, "checkSelection"> {
  return {
    checkSelection: (slug, modelId): Promise<NativeChoice> => {
      asked.push(`${slug}/${modelId}`);
      return Promise.resolve(
        LISTED.has(`${slug}/${modelId}`)
          ? {
              ok: true,
              model: {
                id: modelId,
                name: modelId,
                contextTokens: 128_000,
                outputTokens: 8_000,
                reasoning: false,
                deprecated: false,
                alpha: false,
                price: null,
              },
            }
          : { ok: false, code: "model_not_in_catalog" },
      );
    },
  };
}

async function setup(asked: string[] = []) {
  const app = await setupReviewSettings(undefined, {
    nativeCatalog: catalog(asked),
    // A capability checker that fails the test when it is asked: the metadata of the provider is not the list here.
    modelCapabilities: {
      check: () => {
        throw new Error("the provider's metadata must not be asked");
      },
      lastKnownContextLength: () => null,
    },
  });
  return { ...app, asked };
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

describe("saving a catalog model for Dynamic Review", () => {
  // #555-T04
  it("stores a provider and a model the catalog lists, and reads them back", async () => {
    const app = await setup();

    const view = await app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });

    expect(view.dynamic.effective).toMatchObject({
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });
    expect(view.dynamic.sources).toMatchObject({
      dynamicProvider: "project",
      dynamicModel: "project",
    });
    expect(app.asked).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  // #555-T04
  it("refuses a model the catalog does not hold (released today) with model_not_in_catalog on the field, and stores nothing", async () => {
    const app = await setup();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "deepseek",
        dynamicModel: "released-today",
      }),
    );

    expect(error.code).toBe("REVIEW_SETTINGS_INVALID");
    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "MODEL_NOT_IN_CATALOG" },
    ]);
    expect(await app.projectRows()).toEqual([]);
  });

  // #555-T04
  it("refuses a model of another provider than the one chosen", async () => {
    const app = await setup();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "openai",
        dynamicModel: "deepseek-v4-pro",
      }),
    );

    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "MODEL_NOT_IN_CATALOG" },
    ]);
  });

  // #555-T04
  it("refuses a catalog provider without a model: there is no built-in model for it", async () => {
    const app = await setup();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "deepseek",
      }),
    );

    expect(error.issues).toEqual([{ field: "dynamicModel", code: "EMPTY" }]);
    expect(await app.projectRows()).toEqual([]);
  });

  // #555-T04
  it("checks a change of the provider alone against the model that is stored, and leaves other saves alone", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });
    app.asked.length = 0;

    // A save that touches neither is not checked again: the model may have left the catalog meanwhile.
    await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "off",
    });
    expect(app.asked).toEqual([]);

    // Changing the provider keeps the stored model next to it, and that pair is not in the catalog.
    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "openai",
      }),
    );
    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "MODEL_NOT_IN_CATALOG" },
    ]);
  });

  // #555-T04
  it("goes back to a provider of the registry with its own model, clearing the catalog pair", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });

    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: null,
      dynamicModel: null,
    });

    expect(view.dynamic.sources).toMatchObject({
      dynamicProvider: "built_in",
      dynamicModel: "built_in",
    });
  });

  // #555-T04
  it("does not offer the catalog to the Diff model", async () => {
    const app = await setup();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      }),
    );

    expect(error.issues).toEqual([
      { field: "provider", code: "PROVIDER_UNKNOWN" },
    ]);
  });

  // #555-T08
  it("is not reachable for a workspace on the operator's key: it chooses entries, never a provider or a model", async () => {
    const app = await setupReviewSettings(undefined, {
      operatorsModels: true,
      nativeCatalog: catalog(),
    });

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "deepseek",
        dynamicModel: "deepseek-v4-pro",
      }),
    );

    expect(error.issues.map((issue) => issue.code)).toEqual([
      "MODEL_MANAGED_BY_INSTANCE",
      "MODEL_MANAGED_BY_INSTANCE",
    ]);
  });

  // #555-T04
  it("refuses every catalog choice when the service has no catalog", async () => {
    const app = await setupReviewSettings();

    const error = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        dynamicProvider: "deepseek",
        dynamicModel: "deepseek-v4-pro",
      }),
    );

    expect(error.issues).toEqual([
      { field: "dynamicModel", code: "MODEL_NOT_IN_CATALOG" },
    ]);
  });
});
