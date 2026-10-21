// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The model picker of a project on the workspace's own key (#555): a searchable list of the tool-calling models of the chosen
// catalog provider, with the name, the context size and the price when models.dev states one; the cost and cap note under it
// (#553: a run with no price is bound by a token cap and the time limit, the own-key cost limit does not apply to it).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModelView } from "../catalog.ts";
import {
  CatalogModelPicker,
  type CatalogModelsApi,
} from "./catalog-model-picker.tsx";

afterEach(cleanup);

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
  {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    contextTokens: 128_000,
    outputTokens: 8_000,
    reasoning: false,
    deprecated: false,
    alpha: false,
    price: null,
  },
  {
    id: "old-model",
    name: "Old Model",
    contextTokens: 32_000,
    outputTokens: 4_000,
    reasoning: false,
    deprecated: true,
    alpha: false,
    price: { inputPerMillion: "0", outputPerMillion: "0" },
  },
];

function api(models: NativeModelView[] = MODELS): CatalogModelsApi {
  return {
    models: vi.fn(
      async () =>
        ({ ok: true, data: { provider: "deepseek", models } }) as never,
    ),
  };
}

function picker(
  props: Partial<Parameters<typeof CatalogModelPicker>[0]> = {},
  models: CatalogModelsApi = api(),
) {
  const onChange = vi.fn();
  render(
    <CatalogModelPicker
      workspaceSlug="acme"
      provider="deepseek"
      providerLabel="DeepSeek"
      value=""
      onChange={onChange}
      tokenCap={4_000_000}
      billingOn={false}
      api={models}
      {...props}
    />,
  );
  return { onChange, models };
}

describe("the model picker", () => {
  // #555-T03
  it("asks the models of the chosen provider and lists them with name, context and price when known", async () => {
    const { models } = picker();

    const list = await screen.findByRole("list", { name: "Models" });

    expect(models.models).toHaveBeenCalledWith("deepseek");
    const text = within(list)
      .getAllByRole("listitem")
      .map((i) => i.textContent ?? "");
    expect(text).toHaveLength(3);
    expect(text[0]).toContain("DeepSeek V4 Pro");
    expect(text[0]).toContain("deepseek-v4-pro");
    expect(text[0]).toContain("1,000,000 tokens of context");
    expect(text[0]).toContain("$0.66 in / $1.98 out per million tokens");
    expect(text[1]).toContain("price not listed");
    // A free model has a price: zero.
    expect(text[2]).toContain("$0 in / $0 out per million tokens");
    expect(text[2]).toContain("Deprecated");
  });

  // #555-T03
  it("is searched by name and by id", async () => {
    const user = userEvent.setup();
    picker();
    await screen.findByRole("list", { name: "Models" });

    await user.type(screen.getByLabelText("Search models"), "flash");
    expect(
      within(screen.getByRole("list", { name: "Models" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);

    await user.clear(screen.getByLabelText("Search models"));
    await user.type(screen.getByLabelText("Search models"), "v4-pro");
    expect(
      within(screen.getByRole("list", { name: "Models" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);

    await user.clear(screen.getByLabelText("Search models"));
    await user.type(screen.getByLabelText("Search models"), "zzz");
    expect(screen.getByText("No model matches.")).toBeTruthy();
  });

  // #555-T03
  it("chooses a model by its id", async () => {
    const user = userEvent.setup();
    const { onChange } = picker();

    await user.click(
      await screen.findByRole("button", { name: /DeepSeek Flash/ }),
    );

    expect(onChange).toHaveBeenCalledWith("deepseek-flash");
  });

  // #555-T07
  it("says that a model with no price is bound by the token cap and the time limit, and that the cost limit does not apply", async () => {
    picker({ value: "deepseek-flash" });
    await screen.findByRole("list", { name: "Models" });

    const note = screen.getByTestId("cost-note");
    expect(note.textContent).toContain("bounded by a token cap");
    expect(note.textContent).toContain("4,000,000 tokens");
    expect(note.textContent).toContain("time limit");
    expect(note.textContent).toMatch(/cost limit does not apply/i);
  });

  // #555-T07
  it("shows the price and where it comes from for a model that has one, with the cost limit as before", async () => {
    picker({ value: "deepseek-v4-pro" });
    await screen.findByRole("list", { name: "Models" });

    const note = screen.getByTestId("cost-note");
    expect(note.textContent).toContain("$0.66");
    expect(note.textContent).toContain("$1.98");
    expect(note.textContent).toContain("models.dev");
    expect(note.textContent).toMatch(/cost limit/i);
    expect(note.textContent).not.toMatch(/does not apply/i);
  });

  // #555-T11
  it("says that a run on the own key is charged for infrastructure minutes only when billing is on, with no rate", async () => {
    picker({ value: "deepseek-v4-pro", billingOn: true });
    await screen.findByRole("list", { name: "Models" });

    const note = screen.getByTestId("cost-note");
    expect(note.textContent).toContain("infrastructure minutes only");
    expect(note.textContent).not.toMatch(/per minute|\/ ?min/i);
  });

  // #555-T11
  it("says nothing about charges when billing is off", async () => {
    picker({ value: "deepseek-v4-pro", billingOn: false });
    await screen.findByRole("list", { name: "Models" });

    expect(screen.getByTestId("cost-note").textContent).not.toContain(
      "infrastructure minutes",
    );
  });

  // #555-T09
  it("warns about a saved model the catalog does not list now, and keeps it as the value", async () => {
    picker({ value: "retired-model" });
    await screen.findByRole("list", { name: "Models" });

    expect(screen.getByText(/is not in the catalog now/i)).toBeTruthy();
    // No price is known for it: the run is bound by the cap.
    expect(screen.getByTestId("cost-note").textContent).toContain(
      "bounded by a token cap",
    );
  });

  // #555-T03
  it("tells a person when the models cannot be loaded, and when there are none", async () => {
    const failing: CatalogModelsApi = {
      models: vi.fn(
        async () =>
          ({
            ok: false,
            status: 404,
            code: "provider_not_found",
            issues: [],
          }) as never,
      ),
    };
    picker({}, failing);
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
    cleanup();

    picker({}, api([]));
    expect(await screen.findByText(/lists no model/i)).toBeTruthy();
  });

  // #555-T04
  it("shows the refusal of a save on the field", async () => {
    picker({ error: "This model is not in the catalog." });
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Models" })).toBeTruthy(),
    );

    expect(screen.getByText("This model is not in the catalog.")).toBeTruthy();
  });
});
