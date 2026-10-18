// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The provider and model pickers of a workspace on its own key and the catalog chooser of a workspace on the
// operator's key (#433, ADR 0005): per review kind, with what a member of a managed workspace may see.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateReviewCost } from "../cost.ts";
import { DEFAULT_REVIEW_SKILL } from "../default-skill.ts";
import type { CatalogChoices } from "../catalog-selection.ts";
import {
  MODEL_CHOICE_CHOSEN_UNAVAILABLE,
  MODEL_CHOICE_LOCKED_BADGE,
  MODEL_CHOICE_MANAGE_PLAN,
  MODEL_CHOICE_RETIRED_BADGE,
} from "../../copy/model-choice.ts";
import { createFakeAdapter } from "../../llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../../llm/providers/openrouter/descriptor.ts";
import type { ProjectDynamicView } from "../service.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
  withoutModelFields,
  type ReviewSettings,
} from "../settings.ts";
import type { SettingsApi } from "./api.ts";
import type { SettingsFormModel } from "./form-model.ts";
import { SettingsForm } from "./settings-form.tsx";

// A second provider is registered for this file (the fake adapter of #423), so that what the form derives from the
// registry (the validation of a provider id, the model-id rule, the price table of the cost estimate) is the real
// path for it too. Production registers one provider only.
vi.mock("../../llm/providers/index.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../llm/providers/index.ts")>();
  const { createProviderRegistry } =
    await import("../../llm/providers/registry.ts");
  const { createFakeAdapter } =
    await import("../../llm/providers/fake-adapter.ts");
  return {
    ...original,
    llmProviderDescriptors: createProviderRegistry([
      ...original.llmProviderDescriptors.providers,
      createFakeAdapter(),
    ]),
  };
});

afterEach(cleanup);

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");
const SENTINEL = "sentinel-vendor/secret-model-9";

function dynamicView(
  kind: "diff" | "dynamic",
  managed: boolean,
): ProjectDynamicView {
  const effective: ProjectDynamicView["effective"] = {
    reviewKind: kind,
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    dynamicProvider: "openrouter",
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
    reviewVerdict: "blocking",
  };
  const defaults: ProjectDynamicView["defaults"] = {
    reviewKind: "diff",
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    dynamicProvider: "openrouter",
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
    reviewVerdict: "blocking",
  };
  const sources: ProjectDynamicView["sources"] = {
    reviewKind: "built_in",
    dynamicModel: "built_in",
    dynamicProvider: "built_in",
    reviewSkill: "built_in",
    reviewVerdict: "built_in",
  };
  if (managed)
    for (const field of ["dynamicModel", "dynamicProvider"] as const) {
      delete effective[field];
      delete defaults[field];
      delete sources[field];
    }
  return {
    overrides: {},
    effective,
    sources,
    defaults,
    reviewSkillIsDefault: true,
    defaultSkill: {
      id: DEFAULT_REVIEW_SKILL.id,
      version: DEFAULT_REVIEW_SKILL.version,
      hash: DEFAULT_REVIEW_SKILL.hash,
    },
    limits: { reviewSkillMaxBytes: PROJECT_DYNAMIC_LIMITS.reviewSkillMaxBytes },
  };
}

function ownModel(
  options: {
    kind?: "diff" | "dynamic";
    mode?: "project" | "global";
    overrides?: SettingsFormModel["overrides"];
    inherited?: ReviewSettings;
  } = {},
): SettingsFormModel {
  const inherited = options.inherited ?? BUILT_IN;
  const overrides = options.overrides ?? {};
  const effective = { ...inherited, ...overrides };
  return {
    mode: options.mode ?? "project",
    inherited,
    overrides,
    effective,
    sources: Object.fromEntries(
      Object.keys(effective).map((field) => [
        field,
        Object.hasOwn(overrides, field) ? "project" : "built_in",
      ]),
    ) as SettingsFormModel["sources"],
    cost: estimateReviewCost(effective),
    managed: false,
    catalog: null,
    lastSaved: null,
    ...((options.mode ?? "project") === "project"
      ? { dynamic: dynamicView(options.kind ?? "diff", false) }
      : {}),
  };
}

const CHOICES: CatalogChoices = {
  diff: [
    {
      id: "ent-fast",
      name: "Quick look",
      description: "Fast passes over small changes.",
      available: true,
      reason: null,
    },
    {
      id: "ent-thorough",
      name: "Thorough",
      description: "Careful passes over large changes.",
      available: true,
      reason: null,
    },
    {
      id: "ent-premium",
      name: "Premium",
      description: "The deepest passes we offer.",
      available: false,
      reason: "CATALOG_ENTRY_NOT_ALLOWED",
    },
  ],
  dynamic: [
    {
      id: "ent-explorer",
      name: "Explorer",
      description: "Explores the repository around a change.",
      available: true,
      reason: null,
    },
    {
      id: "ent-detective",
      name: "Detective",
      description: "Follows every call to the end.",
      available: true,
      reason: null,
    },
  ],
};

/** The form model of a managed workspace: the views carry no model and no provider, only the catalog view. */
function managedModel(
  options: {
    kind?: "diff" | "dynamic";
    mode?: "project" | "global";
    choices?: CatalogChoices;
    selection?: { diff: string | null; dynamic: string | null };
    leak?: boolean;
  } = {},
): SettingsFormModel {
  const readable = withoutModelFields(BUILT_IN);
  const mode = options.mode ?? "project";
  // `leak` plants the sentinel where a model would sit if a view ever carried one: the form must not show it.
  const leaked = options.leak
    ? { model: SENTINEL, provider: SENTINEL, fallbackModel: SENTINEL }
    : {};
  const dynamic = dynamicView(options.kind ?? "diff", true);
  if (options.leak) {
    dynamic.effective = {
      ...dynamic.effective,
      dynamicModel: SENTINEL,
      dynamicProvider: SENTINEL as never,
    };
  }
  return {
    mode,
    inherited: readable,
    overrides: {},
    effective: { ...readable, ...leaked } as SettingsFormModel["effective"],
    sources: Object.fromEntries(
      Object.keys(BUILT_IN).map((field) => [field, "built_in"]),
    ) as SettingsFormModel["sources"],
    cost: null,
    managed: true,
    catalog:
      mode === "project"
        ? {
            choices: options.choices ?? CHOICES,
            selection: options.selection ?? { diff: null, dynamic: null },
          }
        : null,
    lastSaved: null,
    ...(mode === "project" ? { dynamic } : {}),
  };
}

function fakeApi() {
  const save = vi.fn<SettingsApi["save"]>(async () => ({
    ok: true,
    data: {},
  }));
  return {
    api: {
      save,
      reset: vi.fn<NonNullable<SettingsApi["reset"]>>(async () => ({
        ok: true,
        data: {},
      })),
    } satisfies SettingsApi,
    save,
  };
}

const SAVE = { name: "Save review settings" };

describe("the provider and model pickers of a workspace on its own key", () => {
  // #433-T01
  it("shows a provider select next to the model of Diff Review", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel()}
        keyedProviders={["openrouter"]}
        api={fakeApi().api}
      />,
    );

    const provider = screen.getByRole("combobox", { name: "Provider" });
    expect(provider.textContent).toContain("OpenRouter");
    const model = screen.getByLabelText("Model") as HTMLInputElement;
    expect(model.value).toBe("anthropic/claude-haiku-5.5");
    const card = provider.closest("fieldset") as HTMLElement;
    expect(within(card).getByLabelText("Model")).toBe(model);
    expect(screen.queryByRole("radiogroup", { name: "Quality" })).toBeNull();
  });

  // #433-T01
  it("offers the models of the chosen provider as suggestions", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel()}
        keyedProviders={["openrouter"]}
        api={fakeApi().api}
      />,
    );

    const list = screen.getByLabelText("Model").getAttribute("list");
    expect(list).not.toBeNull();
    const options = [
      ...(document.getElementById(list ?? "")?.querySelectorAll("option") ??
        []),
    ].map((option) => option.getAttribute("value"));
    expect(options).toEqual([...openrouterDescriptor.suggestedModels]);
  });

  // #433-T01
  it("gives Dynamic Review the same pair, with its own provider and model", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel({ kind: "dynamic" })}
        keyedProviders={["openrouter"]}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    const provider = screen.getByRole("combobox", {
      name: "Dynamic Review provider",
    });
    expect(provider.textContent).toContain("OpenRouter");
    expect(
      (screen.getByLabelText("Dynamic Review model") as HTMLInputElement).value,
    ).toBe(DEFAULT_DYNAMIC_MODEL);
    // The Diff pair belongs to the other kind and is not shown now.
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  });

  // #433-T01
  it("has the provider on the workspace defaults too", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel({ mode: "global" })}
        keyedProviders={["openrouter"]}
        api={fakeApi().api}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Provider" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /Dynamic/ })).toBeNull();
  });

  // #433-T01
  it("marks a provider without a key as 'no key yet' and still lets it be chosen", async () => {
    const user = userEvent.setup();
    const second = createFakeAdapter();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel()}
        keyedProviders={["openrouter"]}
        providers={[openrouterDescriptor, second]}
        api={fakeApi().api}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "OpenRouter",
      "FakeAI (no key yet)",
    ]);
    expect(options[1]?.hasAttribute("data-disabled")).toBe(false);
  });

  // #433-T01
  it("sends the provider and the model when the person changes the model", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel()}
        keyedProviders={["openrouter"]}
        api={api}
      />,
    );

    const model = screen.getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "vendor/other-model");
    await user.click(screen.getByRole("button", SAVE));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ model: "vendor/other-model" });
  });
});

// The second provider (#423 fake adapter): everything the form derives from the provider follows the chosen one.
describe("choosing a provider other than the default", () => {
  const SECOND = createFakeAdapter();

  function renderTwoProviders(model: SettingsFormModel, api: SettingsApi) {
    return render(
      <SettingsForm
        workspaceSlug="acme"
        initial={model}
        keyedProviders={["openrouter", SECOND.id]}
        providers={[openrouterDescriptor, SECOND]}
        api={api}
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

  function suggestionsOf(field: HTMLElement): string[] {
    const list = document.getElementById(field.getAttribute("list") ?? "");
    return [...(list?.querySelectorAll("option") ?? [])].map(
      (option) => option.getAttribute("value") ?? "",
    );
  }

  // #433-T01
  it("switches the suggested models, sends the provider with the model and estimates the cost from the chosen adapter", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderTwoProviders(ownModel(), api);
    const model = screen.getByLabelText("Model", { exact: true });
    expect(suggestionsOf(model)).toEqual([
      ...openrouterDescriptor.suggestedModels,
    ]);

    await choose(user, "Provider", "FakeAI");

    expect(suggestionsOf(model)).toEqual(["fake-small", "fake-large"]);
    await user.type(model, "fake-small");
    // The price table of FakeAI (1 and 2 USD per million tokens), not OpenRouter's.
    expect(
      screen.getByText(/about \$0\.036, at most/, { selector: "li" })
        .textContent,
    ).toMatch(/^Model fake-small:/);
    await user.click(screen.getByRole("button", SAVE));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({
      provider: "fakeai",
      model: "fake-small",
    });
  });

  // #433-T01
  it("clears the model typed for the old provider, and a save without a new one is refused next to the model", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderTwoProviders(ownModel(), api);
    const model = screen.getByLabelText("Model", { exact: true });
    expect((model as HTMLInputElement).value).toBe(BUILT_IN.model);

    await choose(user, "Provider", "FakeAI");

    expect((model as HTMLInputElement).value).toBe("");
    // Nothing can be estimated without a model.
    expect(
      screen.getByText(/shows after the marked values are fixed/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();
    expect(
      within(model.closest("[data-field]") as HTMLElement).getByText(
        "Enter a model name.",
      ),
    ).toBeTruthy();
  });

  // #433-T01
  it("keeps the model when the same provider is chosen again", async () => {
    const user = userEvent.setup();
    renderTwoProviders(ownModel(), fakeApi().api);

    await choose(user, "Provider", "OpenRouter");

    expect(
      (screen.getByLabelText("Model", { exact: true }) as HTMLInputElement)
        .value,
    ).toBe(BUILT_IN.model);
  });

  // #433-T01
  it("takes the provider back to the default together with the model", async () => {
    const user = userEvent.setup();
    renderTwoProviders(ownModel(), fakeApi().api);
    await choose(user, "Provider", "FakeAI");
    await user.type(
      screen.getByLabelText("Model", { exact: true }),
      "fake-small",
    );

    await user.click(
      screen.getByRole("button", { name: "Reset to default for Provider" }),
    );

    expect(
      (screen.getByLabelText("Model", { exact: true }) as HTMLInputElement)
        .value,
    ).toBe(BUILT_IN.model);
    expect(
      screen.getByRole("combobox", { name: "Provider" }).textContent,
    ).toMatch(/OpenRouter/);
  });

  // #433-T01
  it("does the same for the provider and the model of Dynamic Review", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderTwoProviders(ownModel({ kind: "dynamic" }), api);
    const model = screen.getByLabelText("Dynamic Review model");
    expect(suggestionsOf(model)).toEqual([
      ...openrouterDescriptor.suggestedModels,
    ]);

    await choose(user, "Dynamic Review provider", "FakeAI");

    expect((model as HTMLInputElement).value).toBe("");
    expect(suggestionsOf(model)).toEqual(["fake-small", "fake-large"]);
    await user.type(model, "fake-large");
    await user.click(screen.getByRole("button", SAVE));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({
      dynamicProvider: "fakeai",
      dynamicModel: "fake-large",
    });
  });
});

describe("the warning for a provider without a stored key", () => {
  // #433-T11
  it("is shown for the provider of Diff Review, with a link to LLM access", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel()}
        keyedProviders={[]}
        api={fakeApi().api}
      />,
    );

    const warning = screen.getByText(/No key is stored for OpenRouter yet/);
    expect(warning.textContent).toMatch(/reviews .* fail/i);
    const link = within(
      warning.closest("[data-provider-without-key]") as HTMLElement,
    ).getByRole("link", { name: "LLM access" });
    expect(link.getAttribute("href")).toBe("/w/acme/settings/llm");
  });

  // #433-T11
  it("is not shown while the provider has a key", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel()}
        keyedProviders={["openrouter"]}
        api={fakeApi().api}
      />,
    );

    expect(screen.queryByText(/No key is stored/)).toBeNull();
  });

  // #433-T11
  it("is shown for the provider of Dynamic Review while that kind is chosen", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel({ kind: "dynamic" })}
        keyedProviders={[]}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    expect(
      screen.getAllByText(/No key is stored for OpenRouter yet/),
    ).toHaveLength(1);
  });

  // #433-T11
  it("is never shown to a managed workspace", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel()}
        keyedProviders={[]}
        api={fakeApi().api}
      />,
    );

    expect(screen.queryByText(/No key is stored/)).toBeNull();
    expect(screen.queryByRole("link", { name: "LLM access" })).toBeNull();
  });
});

describe("the catalog chooser of a workspace on the operator's key", () => {
  const entry = (name: string) =>
    screen.getByRole("radio", { name: new RegExp(`^${name}`) });

  // #433-T02
  it("lists the entries that serve Diff Review, with name and description, in the order of the view", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel()}
        api={fakeApi().api}
      />,
    );

    const group = screen.getByRole("radiogroup", { name: "Quality" });
    const radios = within(group).getAllByRole("radio");
    expect(
      radios.map((radio) =>
        radio.closest("[data-entry]")?.getAttribute("data-entry"),
      ),
    ).toEqual(["ent-fast", "ent-thorough", "ent-premium"]);
    for (const choice of CHOICES.diff) {
      const card = entry(choice.name).closest("[data-entry]") as HTMLElement;
      expect(within(card).getByText(choice.name)).toBeTruthy();
      expect(within(card).getByText(choice.description ?? "")).toBeTruthy();
    }
    expect(screen.queryByText("Explorer")).toBeNull();
  });

  // #433-T02
  it("lists the entries that serve Dynamic Review once that kind is chosen", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel()}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /^Dynamic Review/ }));

    const group = screen.getByRole("radiogroup", { name: "Quality" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) =>
          radio.closest("[data-entry]")?.getAttribute("data-entry"),
        ),
    ).toEqual(["ent-explorer", "ent-detective"]);
    expect(screen.queryByRole("radio", { name: /^Quick look/ })).toBeNull();
  });

  // #433-T02
  it("shows a note, and no pickers, on the workspace defaults: an entry is chosen per project", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({ mode: "global" })}
        api={fakeApi().api}
      />,
    );

    expect(screen.queryByRole("radiogroup", { name: "Quality" })).toBeNull();
    expect(screen.getByText(/chosen for each project/)).toBeTruthy();
    expect(screen.getByLabelText("Token budget")).toBeTruthy();
  });

  // #433-T02
  it("says so when the instance offers nothing for the kind", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({ choices: { diff: [], dynamic: [] } })}
        api={fakeApi().api}
      />,
    );

    expect(screen.queryByRole("radio", { name: /Quick look/ })).toBeNull();
    expect(screen.getByText(/offers no choice/)).toBeTruthy();
  });

  // #433-T02
  it("shows which entry is chosen, that none is chosen yet, and takes a choice back with Reset to default", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          selection: { diff: "ent-thorough", dynamic: null },
        })}
        api={fakeApi().api}
      />,
    );

    expect(entry("Thorough").getAttribute("aria-checked")).toBe("true");
    const field = screen
      .getByRole("radiogroup", { name: "Quality" })
      .closest("[data-field]") as HTMLElement;
    expect(within(field).getByText("Set for this project")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Reset to default for Quality" }),
    );

    expect(entry("Thorough").getAttribute("aria-checked")).toBe("false");
    expect(within(field).getByText(/default of this instance/)).toBeTruthy();
  });

  // #433-T03
  it("shows an entry the plan does not include as locked, with a link to Manage plan, and does not let it be chosen", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm workspaceSlug="acme" initial={managedModel()} api={api} />,
    );

    const premium = entry("Premium");
    const card = premium.closest("[data-entry]") as HTMLElement;
    expect(within(card).getByText(MODEL_CHOICE_LOCKED_BADGE)).toBeTruthy();
    const link = within(card).getByRole("link", {
      name: MODEL_CHOICE_MANAGE_PLAN,
    });
    expect(link.getAttribute("href")).toBe("/w/acme/settings/plan");
    expect((premium as HTMLButtonElement).disabled).toBe(true);
    expect(entry("Quick look").hasAttribute("disabled")).toBe(false);

    await user.click(premium);
    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeNull();
  });

  // #433-T03
  it("keeps the chosen entry selectable and warns that reviews would not start when it is locked", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          selection: { diff: "ent-premium", dynamic: null },
        })}
        api={fakeApi().api}
      />,
    );

    expect(screen.getByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeTruthy();
    expect(entry("Premium").getAttribute("aria-checked")).toBe("true");
    expect(entry("Premium").hasAttribute("disabled")).toBe(false);
  });

  // #433-T03
  it("shows a retired entry that is still chosen as no longer available, without a link to the plan", () => {
    const choices: CatalogChoices = {
      diff: [
        {
          id: "ent-old",
          name: "Classic",
          description: null,
          available: false,
          reason: "CATALOG_ENTRY_NOT_RELEASED",
        },
        ...CHOICES.diff.slice(0, 1),
      ],
      dynamic: [],
    };
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          choices,
          selection: { diff: "ent-old", dynamic: null },
        })}
        api={fakeApi().api}
      />,
    );

    const card = entry("Classic").closest("[data-entry]") as HTMLElement;
    expect(within(card).getByText(MODEL_CHOICE_RETIRED_BADGE)).toBeTruthy();
    expect(within(card).queryByRole("link")).toBeNull();
    expect(screen.getByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeTruthy();
  });

  // #433-T03
  it("judges the entry of each kind on its own: a locked Diff entry does not warn while Dynamic is chosen", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          selection: { diff: "ent-premium", dynamic: "ent-explorer" },
        })}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    expect(screen.getByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /^Dynamic Review/ }));
    expect(screen.queryByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeNull();
  });

  // #433-T04
  it("shows no provider and no model anywhere in the DOM, even when the model carries them", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({ leak: true, kind: "dynamic" })}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    // The chooser is there, so the test cannot pass on an empty page.
    expect(screen.getByRole("radio", { name: /^Explorer/ })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /^Diff Review/ }));
    expect(screen.getByRole("radio", { name: /^Quick look/ })).toBeTruthy();

    const html = document.body.innerHTML;
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain("sentinel-vendor");
    expect(html).not.toMatch(/openrouter/i);
    expect(html).not.toContain(DEFAULT_DYNAMIC_MODEL);
    expect(html).not.toContain("claude-haiku");
    expect(document.querySelector("datalist")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText(/model/i)).toBeNull();
    expect(screen.queryByText(/Estimated cost/i)).toBeNull();
  });

  // #433-T04
  it("sends no provider and no model in any request body", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({ leak: true })}
        dynamicReviewEnabled
        api={api}
      />,
    );

    await user.click(entry("Thorough"));
    await user.click(screen.getByRole("radio", { name: /^Dynamic Review/ }));
    await user.click(entry("Detective"));
    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "12");
    await user.click(screen.getByRole("button", SAVE));
    // The switch of the review kind asks first.
    await user.click(await screen.findByRole("button", { name: /^Switch to/ }));

    const bodies = JSON.stringify(save.mock.calls.map((call) => call[0]));
    expect(save).toHaveBeenCalled();
    expect(bodies).toContain("catalogEntryDiff");
    expect(bodies).not.toMatch(/model|provider|fallback/i);
    expect(bodies).not.toContain(SENTINEL);
  });

  // #433-T06
  it("keeps both kinds' selections while the kind is switched, and sends both", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel()}
        dynamicReviewEnabled
        api={api}
      />,
    );

    await user.click(entry("Thorough"));
    await user.click(screen.getByRole("radio", { name: /^Dynamic Review/ }));
    await user.click(entry("Detective"));
    await user.click(screen.getByRole("radio", { name: /^Diff Review/ }));

    expect(entry("Thorough").getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("radio", { name: /^Dynamic Review/ }));
    expect(entry("Detective").getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("button", SAVE));
    await user.click(await screen.findByRole("button", { name: /^Switch to/ }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({
      reviewKind: "dynamic",
      catalogEntryDiff: "ent-thorough",
      catalogEntryDynamic: "ent-detective",
    });
  });

  // #433-T06
  it("keeps the typed Dynamic provider and model of an own-key form while the kind is switched", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel({ kind: "dynamic" })}
        keyedProviders={["openrouter"]}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    const model = screen.getByLabelText("Dynamic Review model");
    await user.clear(model);
    await user.type(model, "vendor/agent-model");
    await user.click(screen.getByRole("radio", { name: /^Diff Review/ }));
    await user.click(screen.getByRole("radio", { name: /^Dynamic Review/ }));

    expect(
      (screen.getByLabelText("Dynamic Review model") as HTMLInputElement).value,
    ).toBe("vendor/agent-model");
  });

  // #433-T02
  it("sends only the chosen entry when nothing else changed, and nothing when nothing changed", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm workspaceSlug="acme" initial={managedModel()} api={api} />,
    );

    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();

    await user.click(entry("Quick look"));
    await user.click(screen.getByRole("button", SAVE));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ catalogEntryDiff: "ent-fast" });
  });
});
