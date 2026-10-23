// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The LLM section of a workspace on the operator's key (#433, #656, ADR 0005): one provider, the product name, and a
// dropdown of the entries of the catalog by the names the operator gave them. What a member may see and what a request
// may carry: never a provider or a model id. Ported from the chooser tests of before the dropdowns (#433-T02, T03, T04,
// T06), with the same expectations.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_CHOICE_CHOSEN_UNAVAILABLE,
  MODEL_CHOICE_DEFAULT_OPTION,
  MODEL_CHOICE_LOCKED_BADGE,
  MODEL_CHOICE_MANAGE_PLAN,
  MODEL_CHOICE_NONE_OFFERED,
  MODEL_CHOICE_PER_PROJECT_NOTE,
  MODEL_CHOICE_PROVIDER,
  MODEL_CHOICE_RETIRED_BADGE,
} from "../../copy/model-choice.ts";
import {
  CHOICES,
  fakeApi,
  managedModel,
  ownModel,
  SENTINEL,
} from "../../test-support/settings-form-models.ts";
import {
  chooseOption,
  openSection,
  type SectionName,
} from "../../test-support/settings-sections.ts";
import type { CatalogChoices } from "../catalog-selection.ts";
import { DEFAULT_DYNAMIC_MODEL } from "../settings.ts";
import { SettingsForm } from "./settings-form.tsx";

afterEach(cleanup);

const SAVE = { name: "Save review settings" };
const FALLBACK_REMOVED =
  "The fallback model of the previous provider was removed.";
type User = ReturnType<typeof userEvent.setup>;

const modelDropdown = () => screen.getByLabelText("Model");
const labelOf = (name: string, note?: string) =>
  note === undefined ? name : `${name} (${note})`;

/** Opens the LLM section, then the model dropdown, and names its options. */
async function offered(user: User): Promise<string[]> {
  await user.click(modelDropdown());
  const names = screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return names;
}

async function chooseKind(user: User, kind: "Diff Review" | "Dynamic Review") {
  await openSection(user, "Review");
  await user.click(screen.getByRole("radio", { name: kind }));
  await openSection(user, "LLM");
}

async function renderManaged(
  user: User,
  initial = managedModel(),
  section: SectionName | null = "LLM",
) {
  const { api, save } = fakeApi();
  render(
    <SettingsForm
      workspaceSlug="acme"
      initial={initial}
      dynamicReviewEnabled
      api={api}
    />,
  );
  if (section !== null) await openSection(user, section);
  return { save };
}

describe("the catalog dropdown of a workspace on the operator's key", () => {
  // #433-T02
  it("names the product as the one provider and lists the entries that serve Diff Review in the order of the view", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    expect(screen.getByLabelText("Provider").textContent).toBe(
      MODEL_CHOICE_PROVIDER,
    );
    expect(await offered(user)).toEqual([
      MODEL_CHOICE_DEFAULT_OPTION,
      "Quick look",
      "Thorough",
      labelOf("Premium", MODEL_CHOICE_LOCKED_BADGE),
    ]);
  });

  // #433-T02
  it("lists the entries that serve Dynamic Review once that kind is chosen", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    await chooseKind(user, "Dynamic Review");

    expect(await offered(user)).toEqual([
      MODEL_CHOICE_DEFAULT_OPTION,
      "Explorer",
      "Detective",
    ]);
  });

  // #433-T02
  it("shows a note, and no dropdown of entries, on the workspace defaults: an entry is chosen per project", async () => {
    const user = userEvent.setup();
    await renderManaged(user, managedModel({ mode: "global" }));

    expect(screen.getByText(MODEL_CHOICE_PER_PROJECT_NOTE)).toBeTruthy();
    expect(screen.queryByLabelText("Model")).toBeNull();
    await openSection(user, "Limits");
    expect(screen.getByLabelText("Token budget")).toBeTruthy();
  });

  // #433-T02
  it("says so when the instance offers nothing for the kind", async () => {
    const user = userEvent.setup();
    await renderManaged(
      user,
      managedModel({ choices: { diff: [], dynamic: [] } }),
    );

    expect(screen.getByText(MODEL_CHOICE_NONE_OFFERED)).toBeTruthy();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  // #433-T02
  it("shows which entry is chosen, and takes the choice back with the default option", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(
      user,
      managedModel({ selection: { diff: "ent-thorough", dynamic: null } }),
    );

    expect(modelDropdown().textContent).toBe("Thorough");

    await chooseOption(user, modelDropdown(), MODEL_CHOICE_DEFAULT_OPTION);

    expect(modelDropdown().textContent).toBe(MODEL_CHOICE_DEFAULT_OPTION);
    await user.click(screen.getByRole("button", SAVE));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ catalogEntryDiff: null });
  });

  // #433-T02
  it("shows that none is chosen yet as the default option", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    expect(modelDropdown().textContent).toBe(MODEL_CHOICE_DEFAULT_OPTION);
  });

  // #433-T02
  it("sends only the chosen entry when nothing else changed, and nothing when nothing changed", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(user);

    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();

    await chooseOption(user, modelDropdown(), "Quick look");
    await user.click(screen.getByRole("button", SAVE));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ catalogEntryDiff: "ent-fast" });
  });
});

describe("an entry the plan does not include, or that is retired", () => {
  // #433-T03
  it("shows an entry the plan does not include as locked, with a link to Manage plan, and does not let it be chosen", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(user);

    const link = screen.getByRole("link", { name: MODEL_CHOICE_MANAGE_PLAN });
    expect(link.getAttribute("href")).toBe("/w/acme/settings/plan");
    await user.click(modelDropdown());
    const premium = screen.getByRole("option", {
      name: labelOf("Premium", MODEL_CHOICE_LOCKED_BADGE),
    });
    expect(premium.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("option", { name: "Quick look" })
        .getAttribute("aria-disabled"),
    ).toBeNull();

    await user.click(premium);
    await user.keyboard("{Escape}");
    expect(modelDropdown().textContent).toBe(MODEL_CHOICE_DEFAULT_OPTION);
    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeNull();
  });

  // #433-T03
  it("has no link to the plan while every entry is included", async () => {
    const user = userEvent.setup();
    await renderManaged(
      user,
      managedModel({
        choices: { diff: CHOICES.diff.slice(0, 2), dynamic: [] },
      }),
    );

    expect(screen.queryByRole("link", { name: MODEL_CHOICE_MANAGE_PLAN })).toBe(
      null,
    );
  });

  // #433-T03
  it("keeps the chosen entry selectable and warns that reviews would not start when it is locked", async () => {
    const user = userEvent.setup();
    await renderManaged(
      user,
      managedModel({ selection: { diff: "ent-premium", dynamic: null } }),
    );

    expect(screen.getByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeTruthy();
    expect(modelDropdown().textContent).toBe(
      labelOf("Premium", MODEL_CHOICE_LOCKED_BADGE),
    );
    await user.click(modelDropdown());
    expect(
      screen
        .getByRole("option", {
          name: labelOf("Premium", MODEL_CHOICE_LOCKED_BADGE),
        })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  // #433-T03
  it("shows a retired entry that is still chosen as no longer available, without a link to the plan", async () => {
    const user = userEvent.setup();
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
    await renderManaged(
      user,
      managedModel({ choices, selection: { diff: "ent-old", dynamic: null } }),
    );

    expect(modelDropdown().textContent).toBe(
      labelOf("Classic", MODEL_CHOICE_RETIRED_BADGE),
    );
    expect(screen.queryByRole("link", { name: MODEL_CHOICE_MANAGE_PLAN })).toBe(
      null,
    );
    expect(screen.getByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeTruthy();
  });

  // #433-T03
  it("lists a retired entry that is not chosen as no longer available and does not let it be chosen", async () => {
    const user = userEvent.setup();
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
    await renderManaged(user, managedModel({ choices }));

    await user.click(modelDropdown());
    expect(
      screen
        .getByRole("option", {
          name: labelOf("Classic", MODEL_CHOICE_RETIRED_BADGE),
        })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeNull();
  });

  // #433-T03
  it("judges the entry of each kind on its own: a locked Diff entry does not warn while Dynamic is chosen", async () => {
    const user = userEvent.setup();
    await renderManaged(
      user,
      managedModel({
        selection: { diff: "ent-premium", dynamic: "ent-explorer" },
      }),
    );

    expect(screen.getByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeTruthy();
    await chooseKind(user, "Dynamic Review");
    expect(screen.queryByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeNull();
    expect(modelDropdown().textContent).toBe("Explorer");
  });
});

describe("what a workspace on the operator's key may see and send", () => {
  // #433-T04
  it("shows no provider and no model anywhere in the DOM, even when the views carry them", async () => {
    const user = userEvent.setup();
    await renderManaged(user, managedModel({ leak: true, kind: "dynamic" }));

    const sections: SectionName[] = ["Review", "LLM", "Trigger", "Limits"];
    for (const kind of ["Dynamic Review", "Diff Review"] as const) {
      await chooseKind(user, kind);
      // The dropdown is there, so the test cannot pass on an empty page.
      expect((await offered(user)).length).toBeGreaterThan(1);
      for (const section of sections) {
        await openSection(user, section);
        const html = document.body.innerHTML;
        expect(html).not.toContain(SENTINEL);
        expect(html).not.toContain("sentinel-vendor");
        expect(html).not.toMatch(/openrouter|anthropic/i);
        expect(html).not.toContain(DEFAULT_DYNAMIC_MODEL);
        expect(html).not.toContain("claude-haiku");
        expect(document.querySelector("datalist")).toBeNull();
        expect(screen.queryAllByRole("textbox", { name: /model/i })).toEqual(
          [],
        );
        expect(screen.queryByText(/Estimated cost/i)).toBeNull();
      }
      await openSection(user, "LLM");
    }
  });

  // #433-T04
  it("offers nothing but the names of the entries in the open dropdown", async () => {
    const user = userEvent.setup();
    await renderManaged(user, managedModel({ leak: true }));

    const names = await offered(user);

    expect(names.join("|")).not.toContain(SENTINEL);
    expect(names.join("|")).not.toMatch(/\//);
  });

  // #433-T04
  it("sends no provider and no model in any request body", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(user, managedModel({ leak: true }));

    await chooseOption(user, modelDropdown(), "Thorough");
    await chooseKind(user, "Dynamic Review");
    await chooseOption(user, modelDropdown(), "Detective");
    await openSection(user, "Review");
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
    const { save } = await renderManaged(user);

    await chooseOption(user, modelDropdown(), "Thorough");
    await chooseKind(user, "Dynamic Review");
    await chooseOption(user, modelDropdown(), "Detective");
    await chooseKind(user, "Diff Review");

    expect(modelDropdown().textContent).toBe("Thorough");
    await chooseKind(user, "Dynamic Review");
    expect(modelDropdown().textContent).toBe("Detective");

    await user.click(screen.getByRole("button", SAVE));
    await user.click(await screen.findByRole("button", { name: /^Switch to/ }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({
      reviewKind: "dynamic",
      catalogEntryDiff: "ent-thorough",
      catalogEntryDynamic: "ent-detective",
    });
  });
});

describe("a stored fallback model", () => {
  // #656-T03
  it("is kept by a save and not used: no field for it, not sent, and the estimate lists it as not used yet", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel({
          overrides: { fallbackModel: "vendor/fallback-model" },
        })}
        api={api}
      />,
    );

    await openSection(user, "LLM");
    expect(screen.queryByLabelText(/fallback/i)).toBeNull();
    expect(document.body.innerHTML).not.toContain("vendor/fallback-model");
    await openSection(user, "Limits");
    expect(screen.getByText(/not used yet, so not counted/)).toBeTruthy();

    await openSection(user, "Review");
    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "12");
    await user.click(screen.getByRole("button", SAVE));

    expect(save).toHaveBeenCalledTimes(1);
    // Neither dropped nor cleared: the value goes back as it was, next to the one change.
    expect(save.mock.calls[0]?.[0]).toEqual({
      fallbackModel: "vendor/fallback-model",
      maxFindings: 12,
    });
  });

  // #656-T03
  it("is removed when the provider changes, because a fallback of another provider is invalid, and the form says so", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel({
          overrides: { fallbackModel: "vendor/fallback-model" },
        })}
        keyedProviders={["openrouter", "anthropic"]}
        api={api}
      />,
    );
    await openSection(user, "LLM");
    expect(screen.queryByText(FALLBACK_REMOVED)).toBeNull();

    await chooseOption(user, screen.getByLabelText("Provider"), "Anthropic");

    expect(screen.getByText(FALLBACK_REMOVED)).toBeTruthy();
    await user.click(screen.getByRole("button", SAVE));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ provider: "anthropic" });
    expect(save.mock.calls[0]?.[0]).not.toMatchObject({
      fallbackModel: "vendor/fallback-model",
    });
  });

  // #656-T03
  it("says nothing about a fallback when there was none to remove", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel()}
        keyedProviders={["openrouter", "anthropic"]}
        api={fakeApi().api}
      />,
    );
    await openSection(user, "LLM");

    await chooseOption(user, screen.getByLabelText("Provider"), "Anthropic");

    expect(screen.queryByText(FALLBACK_REMOVED)).toBeNull();
  });

  // #656-T03
  it("keeps the fallback, and says nothing, while the same provider is chosen again", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={ownModel({
          overrides: { fallbackModel: "vendor/fallback-model" },
        })}
        keyedProviders={["openrouter", "anthropic"]}
        api={api}
      />,
    );
    await openSection(user, "LLM");

    await chooseOption(user, screen.getByLabelText("Provider"), "OpenRouter");

    expect(screen.queryByText(FALLBACK_REMOVED)).toBeNull();
    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();
  });
});
