// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the "Review verdict" card of a project's settings form (#405): three modes with the one in force
// selected, what blocking means for the selected review kind, a save that sends only a changed mode (and nothing
// for the default), and a refusal that is shown at the card.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateReviewCost } from "../cost.ts";
import { DEFAULT_REVIEW_SKILL } from "../default-skill.ts";
import type { ProjectDynamicView } from "../service.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
} from "../settings.ts";
import type { SettingsApi } from "./api.ts";
import type { SettingsFormModel } from "./form-model.ts";
import { SettingsForm } from "./settings-form.tsx";
import {
  VERDICT_COMMON_NOTE,
  VERDICT_KIND_NOTES,
} from "./review-verdict-fieldset.tsx";

afterEach(cleanup);

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");
const SHIPPED = DEFAULT_REVIEW_SKILL.text;

function dynamicView(
  overrides: ProjectDynamicView["overrides"] = {},
): ProjectDynamicView {
  return {
    overrides,
    effective: {
      reviewKind: overrides.reviewKind ?? "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
      reviewSkill: SHIPPED,
      reviewVerdict: overrides.reviewVerdict ?? "blocking",
    },
    sources: {
      reviewKind: overrides.reviewKind === undefined ? "built_in" : "project",
      dynamicModel: "built_in",
      reviewSkill: "built_in",
      reviewVerdict:
        overrides.reviewVerdict === undefined ? "built_in" : "project",
    },
    defaults: {
      reviewKind: "diff",
      dynamicModel: DEFAULT_DYNAMIC_MODEL,
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

function projectModel(
  dynamic: ProjectDynamicView = dynamicView(),
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
    managed: false,
    catalog: null,
    lastSaved: null,
    dynamic,
  };
}

function fakeApi(...results: Awaited<ReturnType<SettingsApi["save"]>>[]) {
  const queue = [...results];
  const save = vi.fn<SettingsApi["save"]>(
    async () => queue.shift() ?? { ok: true, data: {} },
  );
  return { api: { save } satisfies SettingsApi, save };
}

const SAVE = { name: "Save review settings" };

function renderForm(
  initial: SettingsFormModel,
  api: SettingsApi,
  readOnly = false,
) {
  return render(
    <SettingsForm
      workspaceSlug="acme"
      initial={initial}
      api={api}
      readOnly={readOnly}
      dynamicReviewEnabled
    />,
  );
}

describe("the Review verdict card", () => {
  // #405-T29
  it("offers the three modes with the one in force selected, the default named", () => {
    renderForm(projectModel(), fakeApi().api);

    const group = screen.getByRole("radiogroup", { name: "Review verdict" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-checked")),
    ).toEqual(["false", "true", "false"]);
    expect(screen.getByRole("radio", { name: "Off" })).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "Blocking findings (default)" }),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Any finding" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Review verdict" }),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(VERDICT_COMMON_NOTE.slice(0, 30))),
    ).toBeTruthy();
  });

  // #405-T29
  it("says what blocking means for the review kind that is selected", async () => {
    const user = userEvent.setup();
    renderForm(projectModel(), fakeApi().api);
    const note = () =>
      screen.getByText(/Posted as a pull request review/).textContent;
    expect(note()).toContain(VERDICT_KIND_NOTES.diff);
    expect(note()).not.toContain(VERDICT_KIND_NOTES.dynamic);

    await user.click(screen.getByRole("radio", { name: "Dynamic Review" }));

    expect(note()).toContain(VERDICT_KIND_NOTES.dynamic);
    expect(note()).not.toContain(VERDICT_KIND_NOTES.diff);
  });

  // #405-T29
  it("shows the mode a project set, as its own", () => {
    renderForm(
      projectModel(dynamicView({ reviewVerdict: "off" })),
      fakeApi().api,
    );

    expect(
      screen.getByRole("radio", { name: "Off" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  // #405-T28
  it("sends only the mode that changed", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderForm(projectModel(), api);

    await user.click(screen.getByRole("radio", { name: "Any finding" }));
    await user.click(screen.getByRole("button", SAVE));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ reviewVerdict: "any" });
  });

  // #405-T28
  it("clears the override when the default is chosen again", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderForm(projectModel(dynamicView({ reviewVerdict: "off" })), api);

    await user.click(
      screen.getByRole("radio", { name: "Blocking findings (default)" }),
    );
    await user.click(screen.getByRole("button", SAVE));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ reviewVerdict: null });
  });

  it("sends nothing for an untouched form", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    renderForm(projectModel(), api);

    await user.click(screen.getByRole("button", SAVE));

    expect(await screen.findByText("No changes to save.")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  // #405-T28
  it("shows a refusal of the server at the card and does not lose the choice", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "reviewVerdict", code: "INVALID_FORMAT" }],
    });
    renderForm(projectModel(), api);

    await user.click(screen.getByRole("radio", { name: "Any finding" }));
    await user.click(screen.getByRole("button", SAVE));

    expect(
      await screen.findByText("Choose Off, Blocking findings or Any finding."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "Any finding" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  // #405-T29
  it("cannot be changed by a person who may only read the settings", () => {
    renderForm(projectModel(), fakeApi().api, true);

    const group = screen.getByRole("radiogroup", { name: "Review verdict" });
    for (const radio of within(group).getAllByRole("radio"))
      expect(radio.matches(":disabled")).toBe(true);
  });

  // #405-T29
  it("is not part of the form of the global defaults", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={{
          ...projectModel(),
          mode: "global",
          dynamic: undefined,
        }}
        api={fakeApi().api}
      />,
    );

    expect(
      screen.queryByRole("radiogroup", { name: "Review verdict" }),
    ).toBeNull();
  });
});
