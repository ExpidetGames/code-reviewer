// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The project settings form with the catalog (#555): the Dynamic provider select offers the catalog providers the workspace holds
// a key for next to the registry's, choosing one swaps the model field for the picker, a pick is saved with the provider, the
// Diff provider select is unchanged, and a workspace on the operator's key sees none of it.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateReviewCost } from "../../review-settings/cost.ts";
import { DEFAULT_REVIEW_SKILL } from "../../review-settings/default-skill.ts";
import type { SettingsApi } from "../../review-settings/ui/api.ts";
import type { SettingsFormModel } from "../../review-settings/ui/form-model.ts";
import { SettingsForm } from "../../review-settings/ui/settings-form.tsx";
import type { ProjectDynamicView } from "../../review-settings/service.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
} from "../../review-settings/settings.ts";
import type { NativeFormData } from "../form-data.ts";
import type { NativeModelView } from "../catalog.ts";
import type { CatalogModelsApi } from "./api.ts";

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
) {
  return render(
    <SettingsForm
      workspaceSlug="acme"
      initial={initial}
      api={api}
      dynamicReviewEnabled
      {...(nativeCatalog === undefined ? {} : { nativeCatalog })}
    />,
  );
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
    const user = userEvent.setup();
    renderForm(model(view({ reviewKind: "dynamic" })), fakeApi().api);

    await user.click(
      screen.getByRole("combobox", { name: "Dynamic Review provider" }),
    );
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);

    expect(options).toEqual(
      expect.arrayContaining(["OpenRouter", "Anthropic", "DeepSeek", "OpenAI"]),
    );
  });

  // #555-T01
  it("keeps the Diff provider select as it was: the registry's providers only, until #558", async () => {
    const user = userEvent.setup();
    renderForm(model(view({ reviewKind: "diff" })), fakeApi().api);

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);

    expect(options).toEqual(["OpenRouter", "Anthropic"]);
  });

  // #555-T03
  it("swaps the model field for the picker when a catalog provider is chosen, and saves provider and model together", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderForm(model(), api);
    expect(screen.queryByLabelText("Search models")).toBeNull();

    await choose(user, "Dynamic Review provider", "DeepSeek");
    await user.click(
      await screen.findByRole("button", { name: /DeepSeek V4 Pro/ }),
    );
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
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderForm(model(), api);

    await choose(user, "Dynamic Review provider", "DeepSeek");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByText(/Enter a model name/i)).toBeTruthy();
  });

  // #555-T04
  it("shows the refusal of a model outside the catalog next to the picker", async () => {
    const user = userEvent.setup();
    const save = vi.fn<SettingsApi["save"]>(async () => ({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "dynamicModel", code: "MODEL_NOT_IN_CATALOG" }],
    }));
    renderForm(model(), { save });

    await choose(user, "Dynamic Review provider", "DeepSeek");
    await user.click(
      await screen.findByRole("button", { name: /DeepSeek V4 Pro/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(await screen.findByText(/is not in the catalog/i)).toBeTruthy();
  });

  // #555-T01
  it("shows the picker straight away for a project that already has a catalog provider, and marks one without a key", async () => {
    renderForm(
      model(view({ dynamicProvider: "openai", dynamicModel: "gpt-5.5" })),
      fakeApi().api,
      {
        ...CATALOG,
        providers: [{ id: "openai", label: "OpenAI", hasKey: false }],
      },
    );

    expect(await screen.findByLabelText("Search models")).toBeTruthy();
    expect(screen.getByText(/No key is stored for OpenAI yet/)).toBeTruthy();
  });

  // #555-T08
  it("is not there for a workspace on the operator's key: no provider, no model, no picker", () => {
    renderForm(model(view(), true), fakeApi().api, undefined);

    expect(screen.queryByLabelText("Search models")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /provider/i })).toBeNull();
    expect(document.body.textContent).not.toContain("DeepSeek");
  });
});
