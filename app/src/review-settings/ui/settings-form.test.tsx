// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the settings form in the browser: wrong values are named next to their field before
// anything is sent, a valid change sends only the fields the person set and shows what the server
// answered, a refusal of the server lands next to its field, "Reset to default" takes a field back, and
// text from the settings is rendered as text.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateReviewCost } from "../cost.ts";
import { DEFAULT_REVIEW_SKILL } from "../default-skill.ts";
import {
  QUALITY_CHOSEN_UNAVAILABLE,
  QUALITY_LEVELS,
  QUALITY_UNAVAILABLE_BADGE,
} from "../../copy/model-quality.ts";
import type { ProjectDynamicView } from "../service.ts";
import {
  builtInReviewSettings,
  DEFAULT_DYNAMIC_MODEL,
  PROJECT_DYNAMIC_LIMITS,
  type ReviewSettings,
  withoutModelFields,
} from "../settings.ts";
import type { TierAvailability } from "../../model-tiers/tiers.ts";
import type { SettingsApi } from "./api.ts";
import type { SettingsFormModel } from "./form-model.ts";
import { SettingsForm } from "./settings-form.tsx";

afterEach(cleanup);

const BUILT_IN = builtInReviewSettings("anthropic/claude-haiku-5.5");

// The project-only view every project form has since #194: Diff Review, the shipped model and skill.
const DYNAMIC_VIEW: ProjectDynamicView = {
  overrides: {},
  effective: {
    reviewKind: "diff",
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
    reviewVerdict: "blocking",
  },
  sources: {
    reviewKind: "built_in",
    dynamicModel: "built_in",
    reviewSkill: "built_in",
    reviewVerdict: "built_in",
  },
  defaults: {
    reviewKind: "diff",
    dynamicModel: DEFAULT_DYNAMIC_MODEL,
    reviewSkill: DEFAULT_REVIEW_SKILL.text,
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

function projectModel(
  overrides: SettingsFormModel["overrides"] = {},
  inherited: ReviewSettings = BUILT_IN,
): SettingsFormModel {
  const effective = { ...inherited, ...overrides };
  const sources = Object.fromEntries(
    Object.keys(effective).map((field) => [
      field,
      Object.hasOwn(overrides, field) ? "project" : "built_in",
    ]),
  ) as SettingsFormModel["sources"];
  return {
    mode: "project",
    inherited,
    overrides,
    effective,
    sources,
    cost: estimateReviewCost(effective),
    managed: false,
    tierAvailability: null,
    lastSaved: null,
    dynamic: DYNAMIC_VIEW,
  };
}

/** The form model of a workspace on the operator's key (#283): no model field, no Dynamic model, no estimate. */
function managedModel(
  options: {
    overrides?: SettingsFormModel["overrides"];
    kind?: "diff" | "dynamic";
    availability?: TierAvailability;
    mode?: "project" | "global";
  } = {},
): SettingsFormModel {
  const overrides = options.overrides ?? {};
  const readable = withoutModelFields(BUILT_IN);
  const effective = { ...readable, ...overrides };
  const sources = Object.fromEntries(
    Object.keys(BUILT_IN).map((field) => [
      field,
      Object.hasOwn(overrides, field) ? "project" : "built_in",
    ]),
  ) as SettingsFormModel["sources"];
  const effectiveDynamic = { ...DYNAMIC_VIEW.effective };
  const defaultsDynamic = { ...DYNAMIC_VIEW.defaults };
  delete effectiveDynamic.dynamicModel;
  delete defaultsDynamic.dynamicModel;
  const dynamic: ProjectDynamicView = {
    ...DYNAMIC_VIEW,
    effective: { ...effectiveDynamic, reviewKind: options.kind ?? "diff" },
    defaults: defaultsDynamic,
  };
  return {
    mode: options.mode ?? "project",
    inherited: readable,
    overrides,
    effective,
    sources,
    cost: null,
    managed: true,
    tierAvailability: options.availability ?? ALL_TIERS,
    lastSaved: null,
    ...((options.mode ?? "project") === "project" ? { dynamic } : {}),
  };
}

const ALL_TIERS: TierAvailability = {
  low: { diff: true, dynamic: true },
  medium: { diff: true, dynamic: true },
  high: { diff: true, dynamic: true },
};

/** The JSON a settings route answers with for a project, built from a model. */
function answerFor(model: SettingsFormModel) {
  return {
    overrides: model.overrides,
    effective: model.effective,
    sources: model.sources,
    inherited: model.inherited,
    cost: model.cost,
    dynamic: model.dynamic,
  };
}

function fakeApi(
  result: Awaited<ReturnType<SettingsApi["save"]>> = { ok: true, data: {} },
) {
  const save = vi.fn<SettingsApi["save"]>(async () => result);
  const reset = vi.fn<NonNullable<SettingsApi["reset"]>>(async () => result);
  return { api: { save, reset } satisfies SettingsApi, save, reset };
}

/**
 * Since #200 a project form that was not changed sends nothing (an empty request would clear the Diff
 * overrides), so a test about what happens to a request makes one change first.
 */
async function changeSomething(user: ReturnType<typeof userEvent.setup>) {
  const findings = screen.getByLabelText("Most findings per review");
  await user.clear(findings);
  await user.type(findings, "12");
}

describe("the settings form", () => {
  it("shows the values in force and where each one comes from", () => {
    const model = projectModel({ maxFindings: 9 });
    render(
      <SettingsForm workspaceSlug="acme" initial={model} api={fakeApi().api} />,
    );

    expect(
      (screen.getByLabelText("Most findings per review") as HTMLInputElement)
        .value,
    ).toBe("9");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
      "anthropic/claude-haiku-5.5",
    );
    const findings = screen
      .getByLabelText("Most findings per review")
      .closest("[data-field]") as HTMLElement;
    const modelField = screen
      .getByLabelText("Model")
      .closest("[data-field]") as HTMLElement;
    expect(within(findings).getByText("Set for this project")).toBeTruthy();
    expect(within(modelField).getByText("Built-in value")).toBeTruthy();
  });

  it("places where a checkbox value comes from right beside the checkbox text", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({ largePrChunking: false })}
        api={fakeApi().api}
      />,
    );

    const field = screen
      .getByLabelText("Review a large pull request in chunks")
      .closest("[data-field]") as HTMLElement;
    const label = screen.getByText("Review a large pull request in chunks");

    // The origin (source and reset action) sits on the same row as the checkbox text.
    expect(label.parentElement?.textContent).toContain("Set for this project");
    expect(
      within(field).getByRole("button", {
        name: "Reset to default for Review a large pull request in chunks",
      }),
    ).toBeTruthy();
  });

  it("places where the comment commands setting comes from beside its heading", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    const heading = screen.getByText("Comment commands people may use");

    expect(heading.nextElementSibling?.textContent).toBe("Built-in value");
  });

  it("explains the model and the token budget in plain words", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    const model = screen
      .getByLabelText("Model")
      .closest("[data-field]") as HTMLElement;
    const budget = screen
      .getByLabelText("Token budget")
      .closest("[data-field]") as HTMLElement;
    expect(model.textContent).toContain("The AI model that writes the review");
    expect(model.textContent).not.toContain("as OpenRouter spells it");
    expect(budget.textContent).toContain(
      "How much of a pull request the model can read in one go",
    );
    expect(budget.textContent).toContain(
      "A token is about three quarters of a word",
    );
    expect(budget.textContent).toContain("8,000");
  });

  // CR-34-T06
  it("names every wrong value next to its field and sends nothing", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "-3");
    const tokens = screen.getByLabelText("Token budget");
    await user.clear(tokens);
    await user.type(tokens, "lots");
    await user.clear(screen.getByLabelText("Model"));
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).not.toHaveBeenCalled();
    const field = (label: string) =>
      screen.getByLabelText(label).closest("[data-field]") as HTMLElement;
    expect(
      within(field("Most findings per review")).getByText("Enter 1 or more."),
    ).toBeTruthy();
    expect(
      within(field("Token budget")).getByText("Enter a whole number."),
    ).toBeTruthy();
    expect(
      within(field("Model")).getByText("Enter a model name."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Model").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByRole("alert").textContent).toMatch(/marked fields/);
    // The first marked control takes the focus (rulebook R20).
    expect(document.activeElement).toBe(screen.getByLabelText("Model"));
  });

  // CR-34-T06
  it("names project rules that are too long", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    await user.click(screen.getByLabelText("Project rules"));
    await user.paste("x".repeat(4001));
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/Use at most 4,000 characters/)).toBeTruthy();
  });

  // CR-34-T06, #203 (an unknown command cannot be typed: the form offers exactly the one that exists)
  it("offers exactly the one comment command that exists", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    expect(
      screen
        .getAllByRole("checkbox", { name: /^\/[a-z]+$/ })
        .map((box) => box.parentElement?.textContent),
    ).toEqual(["/review"]);
  });

  // CR-34-T05
  it("sends only the fields the person changed and shows the answer of the server", async () => {
    const user = userEvent.setup();
    const saved = projectModel({ maxFindings: 12 });
    const { api, save } = fakeApi({ ok: true, data: answerFor(saved) });
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "12");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect(save).toHaveBeenCalledWith({ maxFindings: 12 });
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved\./);
    expect(screen.getByText(/keeps the values it started with/)).toBeTruthy();
    const field = findings.closest("[data-field]") as HTMLElement;
    expect(within(field).getByText("Set for this project")).toBeTruthy();
  });

  // CR-34-T07
  it("puts the field problems of a refusal from the server next to their fields", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "maxTokens", code: "TOO_LARGE" }],
    });
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    await user.type(screen.getByLabelText("Token budget"), "0");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    const field = screen
      .getByLabelText("Token budget")
      .closest("[data-field]") as HTMLElement;
    expect(
      await within(field).findByText(/Enter 2,000,000 or less/),
    ).toBeTruthy();
    expect(screen.queryByText(/Saved\./)).toBeNull();
  });

  // CR-34-T05 (the error EXCEEDS_MODEL_CONTEXT of the service)
  it("explains a token budget that does not fit the model's context window", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "maxTokens", code: "EXCEEDS_MODEL_CONTEXT" }],
    });
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    const tokens = screen.getByLabelText("Token budget");
    await user.clear(tokens);
    await user.type(tokens, "500000");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    const field = tokens.closest("[data-field]") as HTMLElement;
    const message = await within(field).findByText(
      /context window of the chosen model/,
    );
    expect(message.textContent).not.toContain("EXCEEDS_MODEL_CONTEXT");
  });

  it("tells the person when the save fails as a whole", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: null,
      code: "NETWORK_ERROR",
      issues: [],
    });
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /could not be reached/,
    );
  });

  // #174-T04
  it("takes a field back to the inherited value with 'Reset to default', without saving", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi({
      ok: true,
      data: answerFor(projectModel()),
    });
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({ maxFindings: 9 })}
        api={api}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Reset to default for Most findings per review",
      }),
    );

    // The value returns to the built-in immediately, and nothing was saved.
    expect(
      (screen.getByLabelText("Most findings per review") as HTMLInputElement)
        .value,
    ).toBe("5");
    expect(save).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );
    expect(save).toHaveBeenCalledWith({});
  });

  it("resets a project to the defaults for everything after a confirmation, and shows the inherited values", async () => {
    const user = userEvent.setup();
    const { api, reset } = fakeApi({
      ok: true,
      data: answerFor(projectModel()),
    });
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({ maxFindings: 9 })}
        api={api}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset everything" }));
    expect(reset).not.toHaveBeenCalled();
    // The copy names what a full reset takes away (#200 review).
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Review kind/);
    expect(dialog.textContent).toMatch(/review skill/);
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(reset).toHaveBeenCalledTimes(1);
    await screen.findByText(/Saved\./);
    expect(
      (screen.getByLabelText("Most findings per review") as HTMLInputElement)
        .value,
    ).toBe("5");
  });

  it("does not reset anything when the person cancels the confirmation", async () => {
    const user = userEvent.setup();
    const { api, reset } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({ maxFindings: 9 })}
        api={api}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset everything" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(reset).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Reset everything" }),
    ).toBeTruthy();
  });

  it("takes the problem of a field away as soon as the person changes it", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );
    const findings = screen.getByLabelText("Most findings per review");
    await user.clear(findings);
    await user.type(findings, "abc");
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );
    expect(screen.getByText("Enter a whole number.")).toBeTruthy();

    await user.clear(findings);
    await user.type(findings, "7");

    expect(screen.queryByText("Enter a whole number.")).toBeNull();
    expect(findings.getAttribute("aria-invalid")).toBe("false");
  });

  it("shows a problem of the server that belongs to no field, with the message at the foot", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({
      ok: false,
      status: 400,
      code: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "settings", code: "INVALID_TYPE" }],
    });
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Some settings are not valid/);
    expect(alert.textContent).toMatch(/This value is not valid/);
  });

  it("locks the controls while a save is running, so no keystroke is lost", async () => {
    const user = userEvent.setup();
    let finish: (value: { ok: true; data: unknown }) => void = () => undefined;
    const save = vi.fn<SettingsApi["save"]>(
      () => new Promise((resolve) => (finish = resolve)),
    );
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        api={{ save }}
      />,
    );

    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    // A disabled fieldset disables its controls without touching their own `disabled` property.
    const findings = screen.getByLabelText("Most findings per review");
    expect(findings.matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Model").matches(":disabled")).toBe(true);
    finish({ ok: true, data: answerFor(projectModel()) });
    await screen.findByText(/Saved\./);
    expect(findings.matches(":disabled")).toBe(false);
  });

  it("names every reset button after what the person sees, never after the internal field name", async () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({
          largePrChunking: false,
          inlineKeyIssues: true,
          autoReviewOnOpen: false,
          autoReviewOnPush: false,
          allowedCommands: ["review"],
          extraInstructions: "x",
        })}
        api={fakeApi().api}
      />,
    );

    const names = screen
      .getAllByRole("button", { name: /^Reset to default for / })
      .map((button) => button.getAttribute("aria-label"));

    expect(names.length).toBe(6);
    for (const name of names) expect(name).not.toMatch(/[a-z][A-Z]/);
    expect(names).toContain(
      "Reset to default for Review a large pull request in chunks",
    );
    expect(names).toContain("Reset to default for comment commands");
  });

  // CR-34-T05
  it("warns above the cost limit while the person picks a pricey model, and still lets them save", async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    render(
      <SettingsForm workspaceSlug="acme" initial={projectModel()} api={api} />,
    );

    const model = screen.getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "anthropic/claude-sonnet-5.5");

    expect(screen.getByText(/above the limit of \$0\.10/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Save review settings",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  // CR-34-T05
  it("warns that a model has no known price", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    const model = screen.getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "acme/mystery-1");

    expect(screen.getByText(/No price is known for/).textContent).toContain(
      "acme/mystery-1",
    );
  });

  // CR-34-T13
  it("renders project rules with HTML as text in the field and runs nothing", () => {
    const hostile =
      '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
    const { container } = render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({ extraInstructions: hostile })}
        api={fakeApi().api}
      />,
    );

    expect(
      (screen.getByLabelText("Project rules") as HTMLTextAreaElement).value,
    ).toBe(hostile);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  // CR-34-T08
  it("is the same form for the global defaults, without the reset of a project", () => {
    const model: SettingsFormModel = {
      ...projectModel(),
      mode: "global",
      lastSaved: { at: "2026-10-10T12:34:56Z", by: "octocat" },
    };
    const save = vi.fn<SettingsApi["save"]>();

    render(
      <SettingsForm workspaceSlug="acme" initial={model} api={{ save }} />,
    );

    expect(
      screen.getByRole("button", { name: "Save review defaults" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Reset everything/ }),
    ).toBeNull();
    expect(screen.getByText(/Last saved/).textContent).toMatch(
      /Last saved 2026-10-10 12:34 UTC by octocat\./,
    );
  });

  // CR-34-T05 (without a stand-in, a project form talks to the route of its repository)
  it("saves a project through the settings route of its repository when no stand-in is handed in", async () => {
    const user = userEvent.setup();
    const seen: Array<{ url: string; method: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method });
      return new Response("{}", { status: 200 });
    });
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        repositoryId="repo-9"
      />,
    );

    await changeSomething(user);
    await user.click(
      screen.getByRole("button", { name: "Save review settings" }),
    );

    await screen.findByRole("alert");
    expect(seen).toEqual([
      {
        url: "/api/w/acme/repositories/repo-9/project/settings",
        method: "PUT",
      },
    ]);
    vi.unstubAllGlobals();
  });

  // CR-34 (CR-46 review: the fallback model is stored but not sent to the runner yet)
  it("says that the fallback model is stored but not used yet", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel()}
        api={fakeApi().api}
      />,
    );

    const field = screen
      .getByLabelText("Fallback model", { exact: true })
      .closest("[data-field]") as HTMLElement;
    expect(within(field).getByText(/Stored but not used yet/)).toBeTruthy();
  });
});

describe("the settings form of a workspace on the operator's key (#283)", () => {
  const level = (name: "Low" | "Medium" | "High") =>
    screen.getByRole("radio", { name: new RegExp(`^${name}`) });

  // #283-T01
  it("offers one Quality choice of Low, Medium and High instead of the model fields", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel()}
        api={fakeApi().api}
      />,
    );

    const group = screen.getByRole("radiogroup", { name: "Quality" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) =>
          radio.closest("[data-level]")?.getAttribute("data-level"),
        ),
    ).toEqual(["low", "medium", "high"]);
    expect(level("Medium").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByLabelText("Fallback model")).toBeNull();
    expect(screen.queryByLabelText("Dynamic Review model")).toBeNull();
    // The rest of the form is as it was, the token budget included.
    expect(screen.getByLabelText("Token budget")).toBeTruthy();
    expect(screen.getByLabelText("Most findings per review")).toBeTruthy();
  });

  // #283-T01
  it("describes each level by speed and depth, from the copy module", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel()}
        api={fakeApi().api}
      />,
    );

    for (const entry of QUALITY_LEVELS) {
      const card = screen
        .getByRole("radio", { name: new RegExp(`^${entry.label}`) })
        .closest("[data-level]") as HTMLElement;
      expect(within(card).getByText(entry.description)).toBeTruthy();
    }
  });

  // #283-T01
  it("shows no model name, no model list and no cost estimate anywhere", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel()}
        api={fakeApi().api}
      />,
    );

    const html = document.body.innerHTML;
    expect(document.querySelector("datalist")).toBeNull();
    expect(html).not.toContain("claude-haiku");
    expect(html).not.toContain(DEFAULT_DYNAMIC_MODEL);
    expect(screen.queryByText(/Estimated cost/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/chosen by this instance/);
  });

  // #283-T01
  it("sends the chosen level, and no model field, when it is saved", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm workspaceSlug="acme" initial={managedModel()} api={api} />,
    );

    await user.click(level("High"));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual({ modelTier: "high" });
  });

  // #283-T01
  it("sends nothing about the models when something else is saved", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm workspaceSlug="acme" initial={managedModel()} api={api} />,
    );

    await changeSomething(user);
    await user.click(screen.getByRole("button", { name: /save/i }));

    const body = JSON.stringify(save.mock.calls[0]);
    expect(body).toContain("maxFindings");
    expect(body).not.toMatch(/model"|fallbackModel|dynamicModel/);
  });

  // #283-T01
  it("shows where the level comes from and takes an own level back with Reset to default", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({ overrides: { modelTier: "low" } })}
        api={fakeApi().api}
      />,
    );

    expect(level("Low").getAttribute("aria-checked")).toBe("true");
    const field = screen
      .getByRole("radiogroup", { name: "Quality" })
      .closest("[data-field]") as HTMLElement;
    expect(within(field).getByText("Set for this project")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Reset to default for Quality" }),
    );

    expect(level("Medium").getAttribute("aria-checked")).toBe("true");
  });

  // #283-T01
  it("has the same choice on the workspace defaults", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({ mode: "global" })}
        api={api}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Quality" })).toBeTruthy();
    expect(screen.queryByLabelText("Model")).toBeNull();
    await user.click(level("Low"));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(save.mock.calls[0]?.[0]).toEqual({ modelTier: "low" });
  });

  // #283-T01
  it("replaces the Dynamic Review model by the same choice", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({ kind: "dynamic" })}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Quality" })).toBeTruthy();
    expect(screen.getAllByRole("radiogroup", { name: "Quality" })).toHaveLength(
      1,
    );
    expect(screen.queryByLabelText("Dynamic Review model")).toBeNull();
    // The skill is still the project's own.
    expect(screen.getAllByText(/Review skill/i).length).toBeGreaterThan(0);
  });

  // #283-T01
  it("says a level is not available, without saying why, and does not let it be chosen", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          availability: {
            low: { diff: true, dynamic: true },
            medium: { diff: true, dynamic: true },
            high: { diff: false, dynamic: false },
          },
        })}
        api={api}
      />,
    );

    const high = level("High");
    const card = high.closest("[data-level]") as HTMLElement;
    expect(within(card).getByText(QUALITY_UNAVAILABLE_BADGE)).toBeTruthy();
    expect((high as HTMLButtonElement).disabled).toBe(true);
    expect(level("Low").hasAttribute("disabled")).toBe(false);
    await user.click(high);
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(QUALITY_CHOSEN_UNAVAILABLE);
  });

  // #283-T01
  it("warns when the chosen level is not available, and keeps it selectable so nothing changes silently", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          overrides: { modelTier: "high" },
          availability: {
            low: { diff: true, dynamic: true },
            medium: { diff: true, dynamic: true },
            high: { diff: false, dynamic: false },
          },
        })}
        api={fakeApi().api}
      />,
    );

    expect(screen.getByText(QUALITY_CHOSEN_UNAVAILABLE)).toBeTruthy();
    expect(level("High").getAttribute("aria-checked")).toBe("true");
    expect(level("High").hasAttribute("disabled")).toBe(false);
  });

  // #283-T01
  it("judges a level for the kind of review of the project: Diff and Dynamic can differ", async () => {
    const user = userEvent.setup();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          overrides: { modelTier: "low" },
          availability: {
            low: { diff: true, dynamic: false },
            medium: { diff: true, dynamic: true },
            high: { diff: true, dynamic: true },
          },
        })}
        dynamicReviewEnabled
        api={fakeApi().api}
      />,
    );

    expect(screen.queryByText(QUALITY_CHOSEN_UNAVAILABLE)).toBeNull();
    await user.click(screen.getByRole("radio", { name: /^Dynamic Review/ }));

    expect(screen.getByText(QUALITY_CHOSEN_UNAVAILABLE)).toBeTruthy();
  });

  // #283-T01
  it("judges a level on the workspace defaults for every kind", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={managedModel({
          mode: "global",
          availability: {
            low: { diff: true, dynamic: true },
            medium: { diff: true, dynamic: false },
            high: { diff: true, dynamic: true },
          },
        })}
        api={fakeApi().api}
      />,
    );

    expect(screen.getByText(QUALITY_CHOSEN_UNAVAILABLE)).toBeTruthy();
  });

  // #283-T02
  it("shows the model fields exactly as before for a workspace on its own key, and no Quality choice", () => {
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({ model: "vendor/project-model" })}
        api={fakeApi().api}
      />,
    );

    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
      "vendor/project-model",
    );
    expect(screen.getByLabelText("Fallback model")).toBeTruthy();
    expect(screen.getByLabelText("Token budget")).toBeTruthy();
    expect(document.querySelector("datalist")).not.toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Quality" })).toBeNull();
    expect(document.body.textContent).toContain("Estimated cost");
  });

  // #283-T02
  it("still sends the stored level of an own-key workspace through a save, without a control for it", async () => {
    const user = userEvent.setup();
    const { api, save } = fakeApi();
    render(
      <SettingsForm
        workspaceSlug="acme"
        initial={projectModel({ modelTier: "high" })}
        api={api}
      />,
    );

    await changeSomething(user);
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(save.mock.calls[0]?.[0]).toMatchObject({ modelTier: "high" });
  });
});
