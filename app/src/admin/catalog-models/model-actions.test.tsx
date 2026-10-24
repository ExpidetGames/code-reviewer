// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The actions of a catalog model (#554): enable, disable, take the decision back (the model is "new" again), each one a
// request that reloads the page's data, and a refusal as a sentence for its stable code.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import {
  model,
  staleModel,
} from "../../test-support/catalog-models-fixtures.ts";
import type { CatalogModelsApi } from "./api.ts";
import { ModelActions } from "./model-actions.tsx";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const IDS = { providerId: "deepseek", modelId: "deepseek-v4-pro" };
const OK = { ok: true as const, data: { ok: true as const, model: model() } };

function fakeApi(
  answer: RequestResult<{ ok: true; model: ReturnType<typeof model> }> = OK,
) {
  const api = {
    setEnabled: vi.fn(() => Promise.resolve(answer)),
    resetDecision: vi.fn(() => Promise.resolve(answer)),
    confirmPrice: vi.fn(),
    correctPrice: vi.fn(),
    confirmUrl: vi.fn(),
    fetchNow: vi.fn(),
  };
  return api as unknown as CatalogModelsApi & typeof api;
}

function names() {
  return screen
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);
}

describe("the names of the buttons", () => {
  // #554-T01
  it.each([
    ["a new unconfirmed model", () => model({ isNew: true })],
    ["an enabled model", () => model({ enabled: true })],
    ["a disabled model", () => model({ enabled: false })],
    ["a stale model", () => staleModel()],
    [
      "a model with a confirmed price",
      () => model({ price: { ...model().price, status: "confirmed" } }),
    ],
  ])(
    "contain the visible text of the button, for %s (WCAG 2.5.3 label in name)",
    (_name, view) => {
      render(<ModelActions model={view()} api={fakeApi()} />);

      for (const button of screen.getAllByRole("button")) {
        const visible = (button.textContent ?? "").trim().toLowerCase();
        const accessible = (
          button.getAttribute("aria-label") ?? button.textContent
        )
          ?.trim()
          .toLowerCase();
        expect(visible).not.toBe("");
        expect(accessible, visible).toContain(visible);
      }
    },
  );
});

describe("the actions of a model", () => {
  // #554-T01
  it("offers enable and disable for a model nobody has decided about, and no reset", () => {
    render(<ModelActions model={model({ isNew: true })} api={fakeApi()} />);

    expect(names()).toEqual([
      "Review price of DeepSeek V4 Pro",
      "Enable DeepSeek V4 Pro",
      "Disable DeepSeek V4 Pro",
    ]);
  });

  // #554-T01
  it("offers disable and reset for an enabled model", () => {
    render(<ModelActions model={model({ enabled: true })} api={fakeApi()} />);

    expect(names()).toEqual([
      "Review price of DeepSeek V4 Pro",
      "Disable DeepSeek V4 Pro",
      "Reset to new: DeepSeek V4 Pro",
    ]);
  });

  // #554-T01
  it("offers enable and reset for a disabled model", () => {
    render(<ModelActions model={model({ enabled: false })} api={fakeApi()} />);

    expect(names()).toEqual([
      "Review price of DeepSeek V4 Pro",
      "Enable DeepSeek V4 Pro",
      "Reset to new: DeepSeek V4 Pro",
    ]);
  });

  // #554-T02
  it("enables a model with one request and reloads the page's data", async () => {
    const api = fakeApi();
    render(<ModelActions model={model({ isNew: true })} api={api} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Enable DeepSeek V4 Pro" }),
    );

    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(IDS, true));
    expect(await screen.findByText("Enabled.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  // #554-T02
  it("disables a model and takes a decision back", async () => {
    const api = fakeApi();
    render(<ModelActions model={model({ enabled: true })} api={api} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Disable DeepSeek V4 Pro" }),
    );
    await waitFor(() =>
      expect(api.setEnabled).toHaveBeenCalledWith(IDS, false),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reset to new: DeepSeek V4 Pro" }),
    );

    await waitFor(() => expect(api.resetDecision).toHaveBeenCalledWith(IDS));
    expect(await screen.findByText("The decision is taken back.")).toBeTruthy();
  });

  // #554-T04
  it("says the override file blocks a model, and reloads nothing", async () => {
    const api = fakeApi({
      ok: false,
      status: 409,
      code: "model_blocked",
      issues: [],
    });
    render(<ModelActions model={model({ isNew: true })} api={api} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Enable DeepSeek V4 Pro" }),
    );

    expect(
      await screen.findByText(/override file blocks this model/),
    ).toBeTruthy();
    expect(screen.queryByText("Enabled.")).toBeNull();
    expect(navigation.refresh).not.toHaveBeenCalled();
  });
});
