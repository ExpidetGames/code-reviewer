// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The warning for a provider without a stored key (#433-T11, #656): shown in the LLM section for the provider of the
// review kind that is selected, with a link to the LLM page, and never to a workspace on the operator's key. Ported from
// the tests of before the dropdowns, with the same expectations.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeApi,
  managedModel,
  ownModel,
} from "../../test-support/settings-form-models.ts";
import {
  chooseOption,
  openSection,
} from "../../test-support/settings-sections.ts";
import { SettingsForm } from "./settings-form.tsx";
import { CODE_REVIEW_COM } from "../../product-identity/code-review-com.ts";

afterEach(cleanup);

const NO_KEY = /No key is stored for OpenRouter yet/;

function renderForm(
  initial: ReturnType<typeof ownModel>,
  keyedProviders: readonly string[] | undefined,
) {
  return render(
    <SettingsForm
      product={CODE_REVIEW_COM}
      workspaceSlug="acme"
      initial={initial}
      keyedProviders={keyedProviders}
      dynamicReviewEnabled
      api={fakeApi().api}
    />,
  );
}

describe("the warning for a provider without a stored key", () => {
  // #433-T11
  it("is shown for the provider of Diff Review, with a link to the LLM page", async () => {
    const user = userEvent.setup();
    renderForm(ownModel(), []);
    await openSection(user, "LLM");

    const warning = screen.getByText(NO_KEY);
    expect(warning.textContent).toMatch(/reviews .* fail/i);
    const link = within(
      warning.closest("[data-provider-without-key]") as HTMLElement,
    ).getByRole("link", { name: "LLM" });
    expect(link.getAttribute("href")).toBe("/w/acme/settings/llm");
  });

  // #433-T11
  it("is not shown while the provider has a key", async () => {
    const user = userEvent.setup();
    renderForm(ownModel(), ["openrouter"]);
    await openSection(user, "LLM");

    expect(screen.queryByText(/No key is stored/)).toBeNull();
  });

  // #433-T11
  it("is not shown when the page was told nothing about the keys", async () => {
    const user = userEvent.setup();
    renderForm(ownModel(), undefined);
    await openSection(user, "LLM");

    expect(screen.queryByText(/No key is stored/)).toBeNull();
  });

  // #433-T11
  it("is shown for the provider of Dynamic Review while that kind is chosen, and for that one only", async () => {
    const user = userEvent.setup();
    renderForm(ownModel({ kind: "dynamic" }), []);
    await openSection(user, "LLM");

    expect(screen.getAllByText(NO_KEY)).toHaveLength(1);
    expect(screen.getByLabelText("Provider").textContent).toMatch(/OpenRouter/);
  });

  // #433-T11
  it("follows the provider that is chosen: the key of the other provider does not silence it", async () => {
    const user = userEvent.setup();
    renderForm(ownModel(), ["anthropic"]);
    await openSection(user, "LLM");
    expect(screen.getAllByText(NO_KEY)).toHaveLength(1);

    await chooseOption(user, screen.getByLabelText("Provider"), /^Anthropic/);

    expect(screen.queryByText(/No key is stored/)).toBeNull();
  });

  // #433-T11
  it("marks a provider without a key as 'no key yet' and still lets it be chosen, with the warning", async () => {
    const user = userEvent.setup();
    renderForm(ownModel(), ["openrouter"]);
    await openSection(user, "LLM");

    await chooseOption(
      user,
      screen.getByLabelText("Provider"),
      "Anthropic (no key yet)",
    );

    expect(screen.getByLabelText("Provider").textContent).toMatch(/Anthropic/);
    expect(screen.getByText(/No key is stored for Anthropic yet/)).toBeTruthy();
  });

  // #433-T11
  it("is never shown to a workspace on the operator's key", async () => {
    const user = userEvent.setup();
    renderForm(managedModel(), []);
    await openSection(user, "LLM");

    expect(screen.queryByText(/No key is stored/)).toBeNull();
    expect(screen.queryByText(/no key yet/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "LLM" })).toBeNull();
  });
});
