// SPDX-License-Identifier: Apache-2.0

// Saving the Dynamic provider and model of a project with a catalog provider (#555): the model must be in the catalog; a model
// the catalog does not hold, or no longer lists, is refused with `MODEL_NOT_IN_CATALOG` on its field and nothing is stored.
// The Diff model is not offered the catalog (#558). The provider's own model metadata is not asked: the catalog is the list.
import { describe, expect, it } from "vitest";
import type {
  NativeChoice,
  NativeSelectionSource,
} from "../native-providers/catalog.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import { ReviewSettingsError } from "./errors.ts";

const LISTED = new Set(["deepseek/deepseek-v4-pro", "openai/gpt-5.5"]);

/** The address the catalog trusts per offered provider; a test changes it to play a catalog whose address moved (#588). */
const ADDRESSES = new Map<string, string>();

function catalog(asked: string[] = []): NativeSelectionSource {
  ADDRESSES.clear();
  ADDRESSES.set("deepseek", "https://api.deepseek.example");
  ADDRESSES.set("openai", "https://api.openai.example");
  return {
    addressOf: (slug) => Promise.resolve(ADDRESSES.get(slug)),
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

describe("the address a selection pins (#588)", () => {
  const DEEPSEEK = "https://api.deepseek.example";

  async function pinned(app: Awaited<ReturnType<typeof setup>>) {
    const [row] = await app.projectRows();
    return (JSON.parse(row!.settings) as { dynamicProviderAddress?: string })
      .dynamicProviderAddress;
  }

  async function select(app: Awaited<ReturnType<typeof setup>>) {
    return app.service.updateProjectSettings(app.first.id, {
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });
  }

  // #588-T06
  it("writes the address the catalog trusts into the project when the provider is selected, and shows it", async () => {
    const app = await setup();

    const view = await select(app);

    expect(await pinned(app)).toBe(DEEPSEEK);
    expect(view.dynamic.providerAddress).toEqual({
      pinned: DEEPSEEK,
      current: DEEPSEEK,
      state: "pinned",
    });
    // The pin is a view of its own, not one more override a client could send back.
    expect(view.dynamic.overrides).not.toHaveProperty("dynamicProviderAddress");
  });

  // #588-T07
  it("keeps the pin through every save that does not select a provider or confirm, whatever the catalog trusts now", async () => {
    const app = await setup();
    await select(app);
    ADDRESSES.set("deepseek", "https://api.attacker.example");

    await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "off",
    });
    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "deepseek-v4-pro",
    });

    expect(await pinned(app)).toBe(DEEPSEEK);
    expect(view.dynamic.providerAddress).toEqual({
      pinned: DEEPSEEK,
      current: "https://api.attacker.example",
      state: "changed",
    });
  });

  // #588-T08
  it("pins the address the catalog trusts now when the person confirms it, and only then", async () => {
    const app = await setup();
    await select(app);
    ADDRESSES.set("deepseek", "https://api.deepseek-new.example");

    const view = await app.service.updateProjectSettings(
      app.first.id,
      { confirmProviderAddress: true },
      { canManageLlmKey: true },
    );

    expect(await pinned(app)).toBe("https://api.deepseek-new.example");
    expect(view.dynamic.providerAddress).toMatchObject({ state: "pinned" });
  });

  // #588-T09
  it("pins the address of the new provider when the provider changes, and drops the pin when it goes back to the registry", async () => {
    const app = await setup();
    await select(app);

    await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: "openai",
      dynamicModel: "gpt-5.5",
    });
    expect(await pinned(app)).toBe("https://api.openai.example");

    const view = await app.service.updateProjectSettings(app.first.id, {
      dynamicProvider: null,
      dynamicModel: null,
    });
    expect(await pinned(app)).toBeUndefined();
    expect(view.dynamic.providerAddress).toBeNull();
  });

  // #588-T10
  it("refuses to confirm an address when the project has no catalog provider, or the catalog trusts none for it", async () => {
    const app = await setup();

    const none = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        confirmProviderAddress: true,
      }),
    );
    expect(none.issues).toEqual([
      {
        field: "confirmProviderAddress",
        code: "PROVIDER_ADDRESS_NOT_PINNABLE",
      },
    ]);

    await select(app);
    ADDRESSES.delete("deepseek");
    const blocked = await refusal(
      app.service.updateProjectSettings(app.first.id, {
        confirmProviderAddress: true,
      }),
    );
    expect(blocked.issues).toEqual([
      {
        field: "confirmProviderAddress",
        code: "PROVIDER_ADDRESS_NOT_PINNABLE",
      },
    ]);
    expect(await pinned(app)).toBe(DEEPSEEK);
  });

  // #588-T11
  it("leaves a selection made before pins existed unpinned, shows it so, and pins it once when the claim adopts the address", async () => {
    const app = await setup();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    }));
    const before = await app.service.getProjectSettings(app.first.id);
    expect(before.dynamic.providerAddress).toEqual({
      pinned: null,
      current: DEEPSEEK,
      state: "unpinned",
    });

    expect(
      await app.service.adoptProviderAddress(
        app.first.id,
        "deepseek",
        DEEPSEEK,
      ),
    ).toBe(DEEPSEEK);
    // The first adoption stands: a later one (a catalog that moved meanwhile) gets the pin in force, not its own address.
    expect(
      await app.service.adoptProviderAddress(
        app.first.id,
        "deepseek",
        "https://api.attacker.example",
      ),
    ).toBe(DEEPSEEK);
    expect(await pinned(app)).toBe(DEEPSEEK);
  });

  // #588-T11
  it("adopts nothing for a project that no longer selects that provider", async () => {
    const app = await setup();
    await select(app);

    expect(
      await app.service.adoptProviderAddress(
        app.first.id,
        "openai",
        "https://api.openai.example",
      ),
    ).toBeNull();
    expect(await pinned(app)).toBe(DEEPSEEK);
  });

  // #588-T12
  it("is carried through a save of a workspace on the operator's key and cleared by a reset on its own key", async () => {
    const app = await setup();
    await select(app);

    app.setOperatorsModels(true);
    await app.service.updateProjectSettings(app.first.id, {
      reviewVerdict: "off",
    });
    expect(await pinned(app)).toBe(DEEPSEEK);
    const managedView = await app.service.getProjectSettings(app.first.id);
    expect(managedView.dynamic.providerAddress).toBeNull();
    await app.service.resetProjectSettings(app.first.id);
    expect(await pinned(app)).toBe(DEEPSEEK);

    app.setOperatorsModels(false);
    await app.service.resetProjectSettings(app.first.id);
    expect(await pinned(app)).toBeUndefined();
  });
});

// Who may write or move the pin (#588, security review): the roles that may manage the workspace's LLM key (`manage_llm_key`).
// A Member saves the settings of a project; if that save would write a pin that is not the one in force, or drop one the catalog
// no longer trusts, it is refused (`PROVIDER_ADDRESS_CONFIRM_FORBIDDEN`) and the stored pin stays.
describe("who may move the pin (#588)", () => {
  const DEEPSEEK = "https://api.deepseek.example";
  const MOVED = "https://api.deepseek-new.example";
  const MEMBER = { canManageLlmKey: false };
  const ADMIN = { canManageLlmKey: true };

  type App = Awaited<ReturnType<typeof setup>>;

  async function pinOf(app: App, repositoryId: string) {
    const rows = await app.projectRows();
    const row = rows.find((r) => r.repository_id === repositoryId);
    return row === undefined
      ? undefined
      : (JSON.parse(row.settings) as { dynamicProviderAddress?: string })
          .dynamicProviderAddress;
  }

  const SELECT = {
    reviewKind: "dynamic",
    dynamicProvider: "deepseek",
    dynamicModel: "deepseek-v4-pro",
  } as const;

  async function pinnedThenMoved(app: App) {
    await app.service.updateProjectSettings(app.first.id, SELECT, MEMBER);
    ADDRESSES.set("deepseek", MOVED);
  }

  async function forbidden(promise: Promise<unknown>) {
    const error = await refusal(promise);
    expect(error.code).toBe("PROVIDER_ADDRESS_CONFIRM_FORBIDDEN");
  }

  async function otherProjectPin(promise: Promise<unknown>) {
    const error = await refusal(promise);
    expect(error.code).toBe("PROVIDER_ADDRESS_OTHER_PROJECT_PIN");
  }

  // #588-T33
  it("refuses a Member who confirms a moved address, keeps the pin, and lets an Admin do it (P1)", async () => {
    const app = await setup();
    await pinnedThenMoved(app);

    await forbidden(
      app.service.updateProjectSettings(
        app.first.id,
        { confirmProviderAddress: true },
        MEMBER,
      ),
    );
    await forbidden(
      app.service.updateProjectSettings(app.first.id, {
        confirmProviderAddress: true,
      }),
    );
    expect(await pinOf(app, app.first.id)).toBe(DEEPSEEK);

    await app.service.updateProjectSettings(
      app.first.id,
      { confirmProviderAddress: true },
      ADMIN,
    );
    expect(await pinOf(app, app.first.id)).toBe(MOVED);
  });

  // #588-T56
  it("confirms the address without touching the Diff overrides of the project: it is an action of the Dynamic group", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 7 });
    await app.service.updateProjectSettings(app.first.id, SELECT, MEMBER);
    ADDRESSES.set("deepseek", MOVED);

    const view = await app.service.updateProjectSettings(
      app.first.id,
      { confirmProviderAddress: true },
      ADMIN,
    );

    expect(await pinOf(app, app.first.id)).toBe(MOVED);
    expect(view.overrides).toMatchObject({ maxFindings: 7 });
  });

  // #588-T34
  it("refuses a Member who drops the provider while the pin differs from what the catalog trusts, and lets an Admin (P2)", async () => {
    const app = await setup();
    await pinnedThenMoved(app);

    await forbidden(
      app.service.updateProjectSettings(
        app.first.id,
        { dynamicProvider: null, dynamicModel: null },
        MEMBER,
      ),
    );
    await forbidden(
      app.service.updateProjectSettings(
        app.first.id,
        { dynamicProvider: "openai", dynamicModel: "gpt-5.5" },
        MEMBER,
      ),
    );
    expect(await pinOf(app, app.first.id)).toBe(DEEPSEEK);

    await app.service.updateProjectSettings(
      app.first.id,
      { dynamicProvider: null, dynamicModel: null },
      ADMIN,
    );
    expect(await pinOf(app, app.first.id)).toBeUndefined();
  });

  // #588-T35
  it("refuses a Member who resets the project while the pin differs from what the catalog trusts, and lets an Admin (P3)", async () => {
    const app = await setup();
    await pinnedThenMoved(app);

    await forbidden(app.service.resetProjectSettings(app.first.id, MEMBER));
    await forbidden(app.service.resetProjectSettings(app.first.id));
    expect(await pinOf(app, app.first.id)).toBe(DEEPSEEK);

    await app.service.resetProjectSettings(app.first.id, ADMIN);
    expect(await pinOf(app, app.first.id)).toBeUndefined();
  });

  // #588-T36
  it("lets a Member change provider, reset or drop the provider while the pin is the address the catalog trusts", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, SELECT, MEMBER);

    await app.service.updateProjectSettings(
      app.first.id,
      { dynamicProvider: "openai", dynamicModel: "gpt-5.5" },
      MEMBER,
    );
    expect(await pinOf(app, app.first.id)).toBe("https://api.openai.example");
    await app.service.resetProjectSettings(app.first.id, MEMBER);
    expect(await pinOf(app, app.first.id)).toBeUndefined();
  });

  // #588-T37, #614-T02
  it("refuses a Member who selects the provider in a second project at an address other projects of the workspace did not pin, and lets an Admin (P4)", async () => {
    const app = await setup();
    await pinnedThenMoved(app);

    await otherProjectPin(
      app.service.updateProjectSettings(app.second.id, SELECT, MEMBER),
    );
    expect(await pinOf(app, app.second.id)).toBeUndefined();

    await app.service.updateProjectSettings(app.second.id, SELECT, ADMIN);
    expect(await pinOf(app, app.second.id)).toBe(MOVED);
    // The first project still holds to its own pin.
    expect(await pinOf(app, app.first.id)).toBe(DEEPSEEK);
  });

  // #588-T38
  it("lets a Member select the provider in a second project at the address the other projects pinned", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, SELECT, MEMBER);

    await app.service.updateProjectSettings(app.second.id, SELECT, MEMBER);

    expect(await pinOf(app, app.second.id)).toBe(DEEPSEEK);
  });

  // #588-T39, #614-T02
  it("refuses a model-only save of a selection made before pins existed when it would pin an address another project does not hold (P5)", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, SELECT, MEMBER);
    await app.projects.updateSettingsWith(app.second.id, () => ({
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    }));
    ADDRESSES.set("deepseek", MOVED);

    await otherProjectPin(
      app.service.updateProjectSettings(
        app.second.id,
        { dynamicModel: "deepseek-v4-pro" },
        MEMBER,
      ),
    );
    expect(await pinOf(app, app.second.id)).toBeUndefined();

    await app.service.updateProjectSettings(
      app.second.id,
      { dynamicModel: "deepseek-v4-pro" },
      ADMIN,
    );
    expect(await pinOf(app, app.second.id)).toBe(MOVED);
  });

  // #588-T40
  it("leaves a model-only save of a selection made before pins existed to a Member when no other project holds another address", async () => {
    const app = await setup();
    await app.projects.updateSettingsWith(app.first.id, () => ({
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    }));

    await app.service.updateProjectSettings(
      app.first.id,
      { dynamicModel: "deepseek-v4-pro" },
      MEMBER,
    );

    expect(await pinOf(app, app.first.id)).toBe(DEEPSEEK);
  });

  // #588-T41
  it("adopts the address of a claim only when no other project of the workspace pinned another one, else answers that pin", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, SELECT, MEMBER);
    await app.projects.updateSettingsWith(app.second.id, () => ({
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    }));

    expect(
      await app.service.adoptProviderAddress(app.second.id, "deepseek", MOVED),
    ).toBe(DEEPSEEK);
    expect(await pinOf(app, app.second.id)).toBeUndefined();

    expect(
      await app.service.adoptProviderAddress(
        app.second.id,
        "deepseek",
        DEEPSEEK,
      ),
    ).toBe(DEEPSEEK);
    expect(await pinOf(app, app.second.id)).toBe(DEEPSEEK);
  });
});
