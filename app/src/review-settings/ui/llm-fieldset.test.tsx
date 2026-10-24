// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The LLM section of a workspace on the operator's key (#433, #656, #675, #676, ADR 0005): a provider dropdown that names the
// model providers of the catalog (Anthropic, OpenAI, ...; never the product name), then a dropdown of the entries of
// that provider by the names the operator gave them. What a member may see and what a request may carry: the name of the
// provider, never a provider id or a model id. Ported from the chooser tests of before the dropdowns (#433-T02, T03,
// T04, T06), with the same expectations.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_CHOICE_CHOSEN_UNAVAILABLE,
  MODEL_CHOICE_DEFAULT_OPTION,
  MODEL_CHOICE_LOCKED_BADGE,
  MODEL_CHOICE_MANAGE_PLAN,
  MODEL_CHOICE_NONE_CHOSEN,
  MODEL_CHOICE_NONE_OFFERED,
  MODEL_CHOICE_UNAVAILABLE_OPTION,
  MODEL_CHOICE_BILLED_NOTE,
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
const SAVE_DEFAULTS = { name: "Save review defaults" };
const FALLBACK_REMOVED =
  "The fallback model of the previous provider was removed.";
type User = ReturnType<typeof userEvent.setup>;

const modelDropdown = () => screen.getByLabelText("Model");
const providerDropdown = () => screen.getByLabelText("Provider");
const labelOf = (name: string, note?: string) =>
  note === undefined ? name : `${name} (${note})`;

/** Opens the provider dropdown and names its options. */
async function providersOffered(user: User): Promise<string[]> {
  await user.click(providerDropdown());
  const names = screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return names;
}

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
  billingOn = true,
) {
  const { api, save } = fakeApi();
  render(
    <SettingsForm
      workspaceSlug="acme"
      initial={initial}
      dynamicReviewEnabled
      billingOn={billingOn}
      api={api}
    />,
  );
  if (section !== null) await openSection(user, section);
  return { save };
}

describe("the catalog dropdown of a workspace on the operator's key", () => {
  // #675-T01
  it("names the model providers of the entries that serve Diff Review, and never the product, next to the default option", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    expect(await providersOffered(user)).toEqual([
      MODEL_CHOICE_DEFAULT_OPTION,
      "Anthropic",
      "OpenAI",
    ]);
    expect(providerDropdown().textContent).not.toMatch(/code-review\.com/i);
  });

  // #675-T02
  it("lists only the entries of the chosen provider, in the order of the view", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    await chooseOption(user, providerDropdown(), "OpenAI");

    expect(providerDropdown().textContent).toBe("OpenAI");
    expect(await offered(user)).toEqual([
      "Thorough",
      labelOf("Premium", MODEL_CHOICE_LOCKED_BADGE),
    ]);
  });

  // #433-T02
  it("lists the providers and the entries that serve Dynamic Review once that kind is chosen", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    await chooseKind(user, "Dynamic Review");

    expect(await providersOffered(user)).toEqual([
      MODEL_CHOICE_DEFAULT_OPTION,
      "Anthropic",
      "Google",
    ]);
    await chooseOption(user, providerDropdown(), "Anthropic");
    expect(await offered(user)).toEqual(["Explorer"]);
  });

  // #675-T03
  it("says that the managed key is billed via code-review.com, in a note and not as a provider", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    expect(MODEL_CHOICE_BILLED_NOTE).toBe("Billed via code-review.com");
    expect(screen.getByText(MODEL_CHOICE_BILLED_NOTE)).toBeTruthy();
    expect(providerDropdown().textContent).toBe(MODEL_CHOICE_DEFAULT_OPTION);
  });

  // #676-T01
  it("offers the same entries on the workspace defaults and saves the chosen one as the default", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(
      user,
      managedModel({ mode: "global" }),
    );

    expect(providerDropdown().textContent).toBe(MODEL_CHOICE_DEFAULT_OPTION);
    expect(await providersOffered(user)).toEqual([
      MODEL_CHOICE_DEFAULT_OPTION,
      "Anthropic",
      "OpenAI",
    ]);
    expect(screen.getByText(MODEL_CHOICE_BILLED_NOTE)).toBeTruthy();
    await chooseOption(user, providerDropdown(), "OpenAI");
    expect(await offered(user)).toEqual([
      "Thorough",
      labelOf("Premium", MODEL_CHOICE_LOCKED_BADGE),
    ]);
    await chooseKind(user, "Dynamic Review");
    await chooseOption(user, providerDropdown(), "Google");
    await user.click(screen.getByRole("button", SAVE_DEFAULTS));
    // A change of the kind of every project is confirmed first.
    await user.click(
      await screen.findByRole("button", { name: "Switch to Dynamic Review" }),
    );

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toEqual({
      reviewKind: "dynamic",
      catalogEntryDiff: "ent-thorough",
      catalogEntryDynamic: "ent-detective",
    });
  });

  // #676-T02
  it("names the entry the workspace defaults choose as the Default option a project follows, never the product", async () => {
    const user = userEvent.setup();
    await renderManaged(
      user,
      managedModel({
        workspaceSelection: { diff: "ent-thorough", dynamic: null },
      }),
    );

    expect(providerDropdown().textContent).toBe("Default (OpenAI · Thorough)");
    expect(providerDropdown().textContent).not.toMatch(/code-review\.com/i);
    expect(await providersOffered(user)).toEqual([
      "Default (OpenAI · Thorough)",
      "Anthropic",
      "OpenAI",
    ]);
    expect(screen.queryByText(MODEL_CHOICE_NONE_CHOSEN)).toBeNull();
  });

  // #433-T02
  it("says so when code-review.com offers nothing for the kind", async () => {
    const user = userEvent.setup();
    await renderManaged(
      user,
      managedModel({ choices: { diff: [], dynamic: [] } }),
    );

    expect(screen.getByText(MODEL_CHOICE_NONE_OFFERED)).toBeTruthy();
    expect(screen.queryByLabelText("Provider")).toBeNull();
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

    await chooseOption(user, providerDropdown(), MODEL_CHOICE_DEFAULT_OPTION);

    expect(providerDropdown().textContent).toBe(MODEL_CHOICE_DEFAULT_OPTION);
    expect(screen.queryByLabelText("Model")).toBeNull();
    await user.click(screen.getByRole("button", SAVE));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ catalogEntryDiff: null });
  });

  // #433-T02
  it("shows that none is chosen yet as the default option", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    expect(providerDropdown().textContent).toBe(MODEL_CHOICE_DEFAULT_OPTION);
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  // #675-T02
  it("chooses the first entry of a provider that can be chosen when the provider changes, and sends only that entry", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(user);

    await chooseOption(user, providerDropdown(), "OpenAI");

    expect(modelDropdown().textContent).toBe("Thorough");
    await user.click(screen.getByRole("button", SAVE));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({
      catalogEntryDiff: "ent-thorough",
    });
  });

  // #433-T02
  it("sends only the chosen entry when nothing else changed, and nothing when nothing changed", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(user);

    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();

    await chooseOption(user, providerDropdown(), "Anthropic");
    await user.click(screen.getByRole("button", SAVE));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ catalogEntryDiff: "ent-fast" });
  });
});

describe("an entry the plan does not include, or that is retired", () => {
  // #433-T03
  it("shows an entry the plan does not include as locked, with a link to Manage plan, and does not let it be chosen", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    const link = screen.getByRole("link", { name: MODEL_CHOICE_MANAGE_PLAN });
    expect(link.getAttribute("href")).toBe("/w/acme/settings/plan");
    await chooseOption(user, providerDropdown(), "OpenAI");
    await user.click(modelDropdown());
    const premium = screen.getByRole("option", {
      name: labelOf("Premium", MODEL_CHOICE_LOCKED_BADGE),
    });
    expect(premium.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("option", { name: "Thorough" })
        .getAttribute("aria-disabled"),
    ).toBeNull();

    await user.click(premium);
    await user.keyboard("{Escape}");
    expect(modelDropdown().textContent).toBe("Thorough");
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
    expect(providerDropdown().textContent).toBe("OpenAI");
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
          providerLabel: "Anthropic",
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
          providerLabel: "Anthropic",
          available: false,
          reason: "CATALOG_ENTRY_NOT_RELEASED",
        },
        ...CHOICES.diff.slice(0, 1),
      ],
      dynamic: [],
    };
    await renderManaged(user, managedModel({ choices }));

    await chooseOption(user, providerDropdown(), "Anthropic");
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

describe("a provider whose entries the plan does not include, and a chosen entry that is no longer listed", () => {
  const LOCKED_ONLY: CatalogChoices = {
    diff: [
      ...CHOICES.diff.slice(0, 1),
      {
        id: "ent-locked",
        name: "Locked",
        description: null,
        providerLabel: "Lockedlabs",
        available: false,
        reason: "CATALOG_ENTRY_NOT_ALLOWED",
      },
    ],
    dynamic: [],
  };

  // #675-F1
  it("does not offer a provider none of whose entries can be chosen", async () => {
    const user = userEvent.setup();
    await renderManaged(user, managedModel({ choices: LOCKED_ONLY }));

    expect(await providersOffered(user)).toEqual([
      MODEL_CHOICE_DEFAULT_OPTION,
      "Anthropic",
    ]);
  });

  // #675-F1
  it("keeps the provider of a chosen entry that the plan no longer includes, and never turns the saved choice into the default", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(
      user,
      managedModel({
        choices: LOCKED_ONLY,
        selection: { diff: "ent-locked", dynamic: null },
      }),
    );

    expect(providerDropdown().textContent).toBe("Lockedlabs");
    expect(await providersOffered(user)).toContain("Lockedlabs");
    await openSection(user, "Review");
    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "12");
    await user.click(screen.getByRole("button", SAVE));
    expect(save.mock.calls[0]?.[0]).toEqual({ maxFindings: 12 });
  });

  // #675-F2
  it("says the chosen model is unavailable, not Default, when the saved entry is not listed any more", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(
      user,
      managedModel({ selection: { diff: "ent-gone", dynamic: null } }),
    );

    expect(providerDropdown().textContent).toBe(
      MODEL_CHOICE_UNAVAILABLE_OPTION,
    );
    expect(screen.getByText(MODEL_CHOICE_CHOSEN_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText(MODEL_CHOICE_NONE_CHOSEN)).toBeNull();
    await user.click(screen.getByRole("button", SAVE));
    expect(save).not.toHaveBeenCalled();
  });
});

describe("what the default option stands for, and the billing note while billing is off", () => {
  // #675-F5
  it("says under the default option that the default of code-review.com applies", async () => {
    const user = userEvent.setup();
    await renderManaged(user);

    expect(screen.getByText(MODEL_CHOICE_NONE_CHOSEN)).toBeTruthy();
    await chooseOption(user, providerDropdown(), "OpenAI");
    expect(screen.queryByText(MODEL_CHOICE_NONE_CHOSEN)).toBeNull();
  });

  // #675-F5
  it("shows no billing note while billing is off", async () => {
    const user = userEvent.setup();
    await renderManaged(user, managedModel(), "LLM", false);

    expect(providerDropdown()).toBeTruthy();
    expect(screen.queryByText(MODEL_CHOICE_BILLED_NOTE)).toBeNull();
  });
});

describe("what a workspace on the operator's key may see and send", () => {
  // #433-T04, #675-T01
  it("shows no provider id and no model anywhere in the DOM, even when the views carry them", async () => {
    const user = userEvent.setup();
    await renderManaged(user, managedModel({ leak: true, kind: "dynamic" }));

    const sections: SectionName[] = ["Review", "LLM", "Trigger", "Limits"];
    for (const kind of ["Dynamic Review", "Diff Review"] as const) {
      await chooseKind(user, kind);
      // The dropdown is there, so the test cannot pass on an empty page.
      expect((await providersOffered(user)).length).toBeGreaterThan(1);
      for (const section of sections) {
        await openSection(user, section);
        const html = document.body.innerHTML;
        expect(html).not.toContain(SENTINEL);
        expect(html).not.toContain("sentinel-vendor");
        expect(html).not.toMatch(/openrouter/i);
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

    await chooseOption(user, providerDropdown(), "OpenAI");
    const names = await offered(user);

    expect(names.join("|")).not.toContain(SENTINEL);
    expect(names.join("|")).not.toMatch(/\//);
  });

  // #433-T04
  it("sends no provider and no model in any request body", async () => {
    const user = userEvent.setup();
    const { save } = await renderManaged(user, managedModel({ leak: true }));

    await chooseOption(user, providerDropdown(), "OpenAI");
    await chooseKind(user, "Dynamic Review");
    await chooseOption(user, providerDropdown(), "Google");
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

    await chooseOption(user, providerDropdown(), "OpenAI");
    await chooseKind(user, "Dynamic Review");
    await chooseOption(user, providerDropdown(), "Google");
    await chooseKind(user, "Diff Review");

    expect(modelDropdown().textContent).toBe("Thorough");
    await chooseKind(user, "Dynamic Review");
    expect(modelDropdown().textContent).toBe("Detective");

    await user.click(screen.getByRole("button", SAVE));
    await user.click(await screen.findByRole("button", { name: /^Switch to/ }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
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
