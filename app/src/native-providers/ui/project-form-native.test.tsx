// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The project settings form with the catalog (#555, #656): the Dynamic provider dropdown of the LLM section offers the catalog
// providers the workspace holds a key for next to the registry's, choosing one fills the model dropdown with the models of that
// provider, a pick is saved with the provider, the Diff provider dropdown is unchanged, and a workspace on the operator's key
// sees none of it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateReviewCost } from "../../review-settings/cost.ts";
import { DEFAULT_REVIEW_SKILL } from "../../review-settings/default-skill.ts";
import { openSection } from "../../test-support/settings-sections.ts";
import type { SettingsApi } from "../../review-settings/ui/api.ts";
import type { SettingsFormModel } from "../../review-settings/ui/form-model.ts";
import { SettingsForm } from "../../review-settings/ui/settings-form.tsx";
import type { ProjectDynamicView } from "../../review-settings/service.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
} from "../../review-settings/settings.ts";
import { modelChoiceWords } from "../../copy/model-choice.ts";
import type { NativeFormData } from "../form-data.ts";
import type { NativeModelView } from "../catalog.ts";
import type { CatalogModelsApi } from "./api.ts";
import { CODE_REVIEW_COM } from "../../product-identity/code-review-com.ts";

// The picker fetches its list from the app's own route: a stand-in for `fetch` gives it the models.
const MODELS: NativeModelView[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextTokens: 1_000_000,
    outputTokens: 384_000,
    reasoning: true,
    deprecated: false,
    alpha: false,
    price: { inputPerMillion: "0.66", outputPerMillion: "1.98" },
  },
];
const modelsApi: CatalogModelsApi = {
  models: vi.fn(
    async () =>
      ({ ok: true, data: { provider: "deepseek", models: MODELS } }) as never,
  ),
};
vi.mock("./api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.ts")>()),
  browserCatalogModelsApi: () => modelsApi,
}));

afterEach(cleanup);

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");
const SHIPPED = DEFAULT_REVIEW_SKILL.text;

function view(
  overrides: Partial<ProjectDynamicView["effective"]> = {},
): ProjectDynamicView {
  return {
    overrides: {},
    effective: {
      reviewKind: "dynamic",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      dynamicProvider: "openrouter",
      reviewSkill: SHIPPED,
      reviewVerdict: "blocking",
      ...overrides,
    },
    sources: {
      reviewKind: "built_in",
      dynamicModel: "built_in",
      dynamicProvider: "built_in",
      reviewSkill: "built_in",
      reviewVerdict: "built_in",
    },
    defaults: {
      reviewKind: "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      dynamicProvider: "openrouter",
      reviewSkill: SHIPPED,
      reviewVerdict: "blocking",
    },
    reviewSkillIsDefault: true,
    defaultSkill: {
      id: DEFAULT_REVIEW_SKILL.id,
      version: DEFAULT_REVIEW_SKILL.version,
      hash: DEFAULT_REVIEW_SKILL.hash,
    },
    limits: { reviewSkillMaxBytes: PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes },
  };
}

function model(
  dynamic: ProjectDynamicView = view(),
  managed = false,
): SettingsFormModel {
  return {
    mode: "project",
    inherited: BUILT_IN,
    overrides: {},
    effective: BUILT_IN,
    sources: Object.fromEntries(
      Object.keys(BUILT_IN).map((field) => [field, "built_in"]),
    ) as SettingsFormModel["sources"],
    cost: estimateReviewCost(BUILT_IN),
    managed,
    catalog: null,
    operatorMaxCostCents: 100,
    lastSaved: null,
    dynamic,
  };
}

const CATALOG: NativeFormData = {
  providers: [
    { id: "deepseek", label: "DeepSeek", hasKey: true },
    { id: "openai", label: "OpenAI", hasKey: true },
  ],
  tokenCap: 4_000_000,
  billingOn: false,
};

function fakeApi() {
  const save = vi.fn<SettingsApi["save"]>(async () => ({
    ok: true,
    data: {},
  }));
  return { api: { save } satisfies SettingsApi, save };
}

function renderForm(
  initial: SettingsFormModel,
  api: SettingsApi,
  nativeCatalog: NativeFormData | undefined = CATALOG,
  canConfirmProviderAddress = false,
) {
  return render(
    <SettingsForm
      product={CODE_REVIEW_COM}
      workspaceSlug="acme"
      initial={initial}
      api={api}
      dynamicReviewEnabled
      canConfirmProviderAddress={canConfirmProviderAddress}
      {...(nativeCatalog === undefined ? {} : { nativeCatalog })}
    />,
  );
}

async function renderLlm(...args: Parameters<typeof renderForm>) {
  const user = userEvent.setup();
  renderForm(...args);
  await openSection(user, "LLM");
  return user;
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  select: string,
  label: string,
) {
  await user.click(screen.getByRole("combobox", { name: select }));
  await user.click(screen.getByRole("option", { name: label }));
}

describe("the Dynamic provider and model of a project on its own key", () => {
  // #555-T01
  it("offers the catalog providers with a key next to the registry's in the Dynamic select", async () => {
    const user = await renderLlm(
      model(view({ reviewKind: "dynamic" })),
      fakeApi().api,
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);

    expect(options).toEqual(
      expect.arrayContaining(["OpenRouter", "Anthropic", "DeepSeek", "OpenAI"]),
    );
  });

  // #555-T01
  it("keeps the Diff provider select as it was: the registry's providers only, until #558", async () => {
    const user = await renderLlm(
      model(view({ reviewKind: "diff" })),
      fakeApi().api,
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);

    expect(options).toEqual(["OpenRouter", "Anthropic"]);
  });

  // #555-T03
  it("lists the models of a catalog provider when it is chosen, and saves provider and model together", async () => {
    const { api, save } = fakeApi();
    const user = await renderLlm(model(), api);

    await choose(user, "Provider", "DeepSeek");
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Model" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await choose(user, "Model", "DeepSeek V4 Pro");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });
    expect(modelsApi.models).toHaveBeenCalledWith("deepseek");
  });

  // #555-T04
  it("refuses a catalog provider without a model before anything is sent", async () => {
    const { api, save } = fakeApi();
    const user = await renderLlm(model(), api);

    await choose(user, "Provider", "DeepSeek");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByText(/Enter a model name/i)).toBeTruthy();
  });

  // #555-T04
  it("shows the refusal of a model outside the catalog next to the dropdown", async () => {
    const save = vi.fn<SettingsApi["save"]>(async () => ({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "dynamicModel", code: "MODEL_NOT_IN_CATALOG" }],
    }));
    const user = await renderLlm(model(), { save });

    await choose(user, "Provider", "DeepSeek");
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Model" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await choose(user, "Model", "DeepSeek V4 Pro");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(await screen.findByText(/is not in the catalog/i)).toBeTruthy();
  });

  // #555-T01
  it("lists the models straight away for a project that already has a catalog provider, and marks one without a key", async () => {
    await renderLlm(
      model(view({ dynamicProvider: "openai", dynamicModel: "gpt-5.5" })),
      fakeApi().api,
      {
        ...CATALOG,
        providers: [{ id: "openai", label: "OpenAI", hasKey: false }],
      },
    );

    await waitFor(() =>
      expect(modelsApi.models).toHaveBeenCalledWith("openai"),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(screen.getByText(/No key is stored for OpenAI yet/)).toBeTruthy();
  });

  // #555-T08, #656-T03, #675-T01
  it("is not there for a workspace on the operator's key: no provider of the catalog, no catalog models, and the product is no provider", async () => {
    await renderLlm(model(view(), true), fakeApi().api, undefined);

    expect(screen.queryByLabelText("Search models")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
    expect(
      screen.getByText(modelChoiceWords(CODE_REVIEW_COM).noneOffered),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("DeepSeek");
  });
});

describe("the pinned address of a catalog provider in the project form (#588)", () => {
  const OLD = "https://api.deepseek.example";
  const NEW = "https://api.deepseek-new.example";

  function withAddress(
    providerAddress: NonNullable<ProjectDynamicView["providerAddress"]>,
  ) {
    return {
      ...view({ dynamicProvider: "deepseek", dynamicModel: "deepseek-v4-pro" }),
      providerAddress,
    };
  }

  // #588-T30
  it("shows the pinned address of the project's catalog provider, read-only", async () => {
    await renderLlm(
      model(withAddress({ pinned: OLD, current: OLD, state: "pinned" })),
      fakeApi().api,
    );

    expect(await screen.findByText(OLD)).toBeTruthy();
    expect(
      screen.queryByRole("checkbox", { name: /confirm the new address/i }),
    ).toBeNull();
  });

  // #588-T30
  it("saves the confirmation of a new address as its own action, with no other field", async () => {
    const { api, save } = fakeApi();
    const user = await renderLlm(
      model(withAddress({ pinned: OLD, current: NEW, state: "changed" })),
      api,
      CATALOG,
      true,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.click(
      screen.getByRole("checkbox", { name: /confirm the new address/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toEqual({ confirmProviderAddress: true });
  });

  // #588-T30
  it("hides the note for a provider the person chose instead, whose address is fixed by its own selection", async () => {
    const user = await renderLlm(
      model(withAddress({ pinned: OLD, current: NEW, state: "changed" })),
      fakeApi().api,
      CATALOG,
      true,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();

    await choose(user, "Provider", "OpenAI");

    expect(
      screen.queryByRole("checkbox", { name: /confirm the new address/i }),
    ).toBeNull();
  });

  // #588-T45
  it("offers a person who may not manage the LLM key no confirmation, and says an Owner or Admin must confirm", async () => {
    const { api, save } = fakeApi();
    await renderLlm(
      model(withAddress({ pinned: OLD, current: NEW, state: "changed" })),
      api,
    );

    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain(OLD);
    expect(warning.textContent).toContain(NEW);
    expect(warning.textContent).toMatch(/an owner or admin must confirm/i);
    expect(
      screen.queryByRole("checkbox", { name: /confirm the new address/i }),
    ).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  // #588-T30
  it("shows no address for a project on a registry provider", async () => {
    await renderLlm(model(view({ reviewKind: "dynamic" })), fakeApi().api);

    expect(document.body.textContent).not.toContain("fixed when this provider");
  });
});
