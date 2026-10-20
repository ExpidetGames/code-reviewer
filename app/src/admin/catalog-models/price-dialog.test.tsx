// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// The price of a catalog model (#554): what the admin is shown (today's price with its sources, and for a stale price both
// prices), confirming exactly what they saw (with its hash), correcting it (dollars typed, micro-USD sent, a reason
// required, tiers ascending) and what each refusal looks like (a stable code as a sentence, a reload when the catalog moved,
// another try when the daily fetch holds the lock).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogModelView } from "../../model-prices/admin-view.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import {
  CATALOG_SOURCES,
  book,
  model,
  staleModel,
  staleModelBetween,
  TODAY,
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
type Answer = RequestResult<{ ok: true; model: CatalogModelView }>;
const OK: Answer = { ok: true, data: { ok: true, model: model() } };
const refused = (code: string, status = 409): Answer => ({
  ok: false,
  status,
  code,
  issues: [],
});

function fakeApi(answer: Answer = OK) {
  const api = {
    setEnabled: vi.fn(() => Promise.resolve(answer)),
    resetDecision: vi.fn(() => Promise.resolve(answer)),
    confirmPrice: vi.fn(() => Promise.resolve(answer)),
    correctPrice: vi.fn(() => Promise.resolve(answer)),
    confirmUrl: vi.fn(),
    fetchNow: vi.fn(),
  };
  return api satisfies Record<
    keyof CatalogModelsApi,
    unknown
  > as unknown as CatalogModelsApi & typeof api;
}

async function openPrice(view: CatalogModelView, api = fakeApi()) {
  const user = userEvent.setup();
  render(<ModelActions model={view} api={api} />);
  await user.click(
    screen.getByRole("button", { name: /(Review price|Price) of/ }),
  );
  const dialog = await screen.findByRole("dialog");
  return { user, api, dialog: within(dialog) };
}

describe("the price a model is shown with", () => {
  // #554-T02
  it("shows the price today with the source of each amount, and what the status means", async () => {
    const { dialog } = await openPrice(model());

    expect(
      dialog.getByRole("heading", { name: "Price of DeepSeek V4 Pro" }),
    ).toBeTruthy();
    expect(dialog.getByText("Unconfirmed")).toBeTruthy();
    expect(dialog.getByText(/Nobody has confirmed this price/)).toBeTruthy();
    const table = within(dialog.getByRole("table", { name: "Price now" }));
    expect(table.getByText("$0.60")).toBeTruthy();
    expect(table.getByText("$1.20")).toBeTruthy();
    expect(table.getByText("$0.06")).toBeTruthy();
    expect(table.getAllByText("models.dev").length).toBeGreaterThanOrEqual(3);
  });

  // #554-T02
  it("names where an amount comes from when it is an override or a correction", async () => {
    const view = model({
      price: {
        ...model().price,
        reference: {
          book: book("600000", "1200000", { cacheWrite1h: "9000000" }),
          hash: "v2:abc123",
          sources: { ...CATALOG_SOURCES, cacheWrite1h: "override" },
        },
      },
    });
    const { dialog } = await openPrice(view);

    const table = within(dialog.getByRole("table", { name: "Price now" }));
    expect(table.getByText("Override file")).toBeTruthy();
    expect(table.getByText("$9.00")).toBeTruthy();
  });

  // #554-T05
  it("shows both prices of a stale price and says the confirmed one is no longer current", async () => {
    const { dialog } = await openPrice(staleModel());

    expect(dialog.getByText("Stale")).toBeTruthy();
    expect(
      within(dialog.getByRole("table", { name: "Price now" })).getByText(
        "$0.60",
      ),
    ).toBeTruthy();
    expect(
      within(
        dialog.getByRole("table", { name: "Price confirmed before" }),
      ).getByText("$0.50"),
    ).toBeTruthy();
    expect(dialog.getByText("Price now (to confirm)")).toBeTruthy();
    expect(
      dialog.getByText(/Price you confirmed before \(no longer current\)/),
    ).toBeTruthy();
  });

  // #554-T05
  it("marks the fields that moved in both tables and says in which fields the price differs", async () => {
    const { dialog } = await openPrice(
      staleModelBetween(
        book("500000", "1000000", { cacheRead: "50000" }),
        book("500000", "1000000", { cacheRead: "60000", reasoning: "2000000" }),
      ),
    );

    expect(
      dialog.getByText(
        "Differs from your confirmation in: cache read, reasoning.",
      ),
    ).toBeTruthy();
    const now = within(dialog.getByRole("table", { name: "Price now" }));
    for (const field of ["Cache read", "Reasoning"])
      expect(
        within(now.getByText(field).closest("tr")!).getByText("Changed"),
      ).toBeTruthy();
    for (const field of ["Input", "Output"])
      expect(
        within(now.getByText(field).closest("tr")!).queryByText("Changed"),
      ).toBeNull();
    const before = within(
      dialog.getByRole("table", { name: "Price confirmed before" }),
    );
    expect(
      within(before.getByText("Cache read").closest("tr")!).getByText(
        "Changed",
      ),
    ).toBeTruthy();
    expect(before.getAllByText("Changed")).toHaveLength(1);
  });

  // #554-T05
  it("says that no amount differs when the confirmation is stale for another reason", async () => {
    const same = book("500000", "1000000", { cacheRead: "50000" });
    const { dialog } = await openPrice(staleModelBetween(same, { ...same }));

    expect(dialog.getByText(/No amount differs/)).toBeTruthy();
    expect(dialog.queryByText("Changed")).toBeNull();
  });

  // #554-T05
  it("marks nothing for a price that is not stale", async () => {
    const { dialog } = await openPrice(model());

    expect(dialog.queryByText("Changed")).toBeNull();
    expect(dialog.queryByText(/Differs from your confirmation/)).toBeNull();
  });

  // #554-T05
  it("warns that the last confirmation could not be read", async () => {
    const view = model({
      price: { ...model().price, warnings: ["confirmation_unreadable"] },
    });
    const { dialog } = await openPrice(view);

    expect(
      dialog.getByText(/could not be read, so the price counts as unconfirmed/),
    ).toBeTruthy();
  });

  // #554-T02
  it("shows no table and nothing to confirm for a model models.dev states no price for", async () => {
    const view = model({
      price: {
        ...model().price,
        status: "unpriced",
        book: null,
        sources: null,
        reference: { book: null, hash: "v2:none", sources: null },
      },
    });
    const { dialog } = await openPrice(view);

    expect(dialog.queryByRole("table")).toBeNull();
    expect(
      dialog.getByText(
        "models.dev states no price we can read for this model.",
      ),
    ).toBeTruthy();
    expect(dialog.getByText(/Enter the price yourself/)).toBeTruthy();
    expect(
      (
        dialog.getByRole("button", {
          name: "Confirm price as shown",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        dialog.getByRole("button", {
          name: "Correct price",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  // #554-T02
  it("has nothing left to confirm once the price is confirmed", async () => {
    const view = staleModel();
    const confirmed = model({
      price: {
        ...view.price,
        status: "confirmed",
        book: TODAY,
        reference: { ...view.price.reference, book: TODAY },
      },
    });
    const { dialog } = await openPrice(confirmed);

    expect(
      dialog.getByRole("heading", { name: "Confirmed price" }),
    ).toBeTruthy();
    expect(
      within(dialog.getByRole("table", { name: "Confirmed price" })).getByText(
        "$0.60",
      ),
    ).toBeTruthy();
    expect(
      (
        dialog.getByRole("button", {
          name: "Confirm price as shown",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // #554-T02
  it("shows a corrected price as the confirmed one, with the correction as its source, and the catalog's price apart", async () => {
    const view = staleModel();
    const corrected = model({
      price: {
        ...view.price,
        status: "confirmed",
        book: book("700000", "1300000"),
        sources: {
          ...CATALOG_SOURCES,
          input: "admin",
          output: "admin",
          cacheRead: null,
        },
        confirmation: {
          ...view.price.confirmation!,
          source: "admin",
          reason: "Invoice.",
        },
      },
    });
    const { dialog } = await openPrice(corrected);

    const confirmed = within(
      dialog.getByRole("table", { name: "Confirmed price" }),
    );
    expect(confirmed.getByText("$0.70")).toBeTruthy();
    expect(confirmed.getAllByText("Your correction")).toHaveLength(2);
    const catalog = within(
      dialog.getByRole("table", { name: "Catalog price today" }),
    );
    expect(catalog.getByText("$0.60")).toBeTruthy();
    expect(dialog.getByText(/not what the managed key uses/)).toBeTruthy();
  });
});

describe("confirming the price as shown", () => {
  // #554-T02
  it("sends the hash of the price the admin saw, as it is, and reloads the page", async () => {
    const { user, api, dialog } = await openPrice(model());

    await user.click(
      dialog.getByRole("button", { name: "Confirm price as shown" }),
    );

    await waitFor(() =>
      expect(api.confirmPrice).toHaveBeenCalledWith(IDS, "v2:abc123"),
    );
    expect(await dialog.findByText("Price confirmed.")).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #554-T05
  it("reconfirms a stale price against the new reference, not the old one", async () => {
    const { user, api, dialog } = await openPrice(staleModel());

    await user.click(
      dialog.getByRole("button", { name: "Confirm price as shown" }),
    );

    await waitFor(() =>
      expect(api.confirmPrice).toHaveBeenCalledWith(IDS, "v2:newhash"),
    );
  });

  // #554-T04
  it("says the catalog price changed meanwhile, reloads the page and confirms nothing", async () => {
    const { user, api, dialog } = await openPrice(
      model(),
      fakeApi(refused("price_changed")),
    );

    await user.click(
      dialog.getByRole("button", { name: "Confirm price as shown" }),
    );

    expect(
      await dialog.findByText(/changed while you were looking at it/),
    ).toBeTruthy();
    expect(dialog.queryByText("Price confirmed.")).toBeNull();
    expect(api.confirmPrice).toHaveBeenCalledTimes(1);
    expect(navigation.refresh).toHaveBeenCalled();
    expect(dialog.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  // #554-T04
  it("offers another try when the daily fetch holds the catalog, and the try is the same request", async () => {
    const api = fakeApi(refused("fetch_in_progress"));
    const { user, dialog } = await openPrice(model(), api);

    await user.click(
      dialog.getByRole("button", { name: "Confirm price as shown" }),
    );
    expect(
      await dialog.findByText(/daily fetch is writing the catalog/),
    ).toBeTruthy();
    expect(navigation.refresh).not.toHaveBeenCalled();
    api.confirmPrice.mockResolvedValueOnce(OK);
    await user.click(dialog.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(api.confirmPrice).toHaveBeenCalledTimes(2));
    expect(api.confirmPrice).toHaveBeenLastCalledWith(IDS, "v2:abc123");
    expect(await dialog.findByText("Price confirmed.")).toBeTruthy();
  });

  // #554-T04
  it.each([
    ["price_missing", /states no price we can read/],
    ["model_unknown", /no longer has this model/],
    ["unavailable", /could not be read or written/],
    ["NETWORK_ERROR", /could not be reached/],
  ])("shows a sentence for %s, never the code", async (code, sentence) => {
    const { user, dialog } = await openPrice(model(), fakeApi(refused(code)));

    await user.click(
      dialog.getByRole("button", { name: "Confirm price as shown" }),
    );

    const alert = await dialog.findByRole("alert");
    expect(alert.textContent).toMatch(sentence);
    expect(alert.textContent).not.toContain(code);
  });
});

describe("correcting the price", () => {
  async function openForm(view = model(), api = fakeApi()) {
    const opened = await openPrice(view, api);
    await opened.user.click(
      opened.dialog.getByRole("button", { name: "Correct price" }),
    );
    const form = within(
      await screen.findByRole("form", { name: "Correct the price" }),
    );
    return { ...opened, form };
  }

  // #554-T03
  it("starts from today's price in dollars, with the older fields empty", async () => {
    const { form } = await openForm();

    expect(
      (
        form.getByLabelText(
          "Input (USD per million tokens)",
        ) as HTMLInputElement
      ).value,
    ).toBe("0.6");
    expect(
      (
        form.getByLabelText(
          "Output (USD per million tokens)",
        ) as HTMLInputElement
      ).value,
    ).toBe("1.2");
    expect(
      (
        form.getByLabelText(
          "Cache read (USD per million tokens)",
        ) as HTMLInputElement
      ).value,
    ).toBe("0.06");
    expect(
      (
        form.getByLabelText(
          "Reasoning (USD per million tokens)",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  // #554-T03
  it("sends whole micro-USD digit strings, the reason and the hash of the price it started from", async () => {
    const { user, api, form } = await openForm();
    const input = form.getByLabelText("Input (USD per million tokens)");
    await user.clear(input);
    await user.type(input, "0.7");
    await user.type(
      form.getByLabelText("Cache write, 1 hour (USD per million tokens)"),
      "1.25",
    );
    await user.type(form.getByLabelText("Reason"), "Invoice of October.");

    await user.click(
      form.getByRole("button", { name: "Save corrected price" }),
    );

    await waitFor(() => expect(api.correctPrice).toHaveBeenCalledTimes(1));
    expect(api.correctPrice).toHaveBeenCalledWith(
      IDS,
      "v2:abc123",
      book("700000", "1200000", {
        cacheRead: "60000",
        cacheWrite1h: "1250000",
      }),
      "Invoice of October.",
    );
    expect(
      await screen.findByText("Price corrected and confirmed."),
    ).toBeTruthy();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  // #554-T03
  it("requires a reason and sends nothing without one", async () => {
    const { user, api, form } = await openForm();

    await user.click(
      form.getByRole("button", { name: "Save corrected price" }),
    );

    expect(
      await form.findByText(/Enter a reason of 1 to 500 characters/),
    ).toBeTruthy();
    expect(document.activeElement).toBe(form.getByLabelText("Reason"));
    expect(api.correctPrice).not.toHaveBeenCalled();
  });

  // #554-T03
  it("names a negative or malformed amount at its field and focuses the first", async () => {
    const { user, api, form } = await openForm();
    const input = form.getByLabelText("Input (USD per million tokens)");
    await user.clear(input);
    await user.type(input, "-1");
    const output = form.getByLabelText("Output (USD per million tokens)");
    await user.clear(output);
    await user.type(output, "2,5");
    await user.type(form.getByLabelText("Reason"), "Invoice.");

    await user.click(
      form.getByRole("button", { name: "Save corrected price" }),
    );

    expect(await form.findByText("A price cannot be negative.")).toBeTruthy();
    expect(
      form.getByText(
        /Enter dollars per million tokens as a number with a point/,
      ),
    ).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(api.correctPrice).not.toHaveBeenCalled();
  });

  // #554-T03
  it("adds tiers, which must start above the one before", async () => {
    const { user, api, form } = await openForm();
    await user.type(form.getByLabelText("Reason"), "Invoice.");
    for (const contextOver of ["200000", "100000"]) {
      await user.click(
        form.getByRole("button", { name: "Add a context tier" }),
      );
      const tiers = form.getAllByLabelText(/Applies above this many tokens/);
      const last = tiers[tiers.length - 1] as HTMLElement;
      await user.type(last, contextOver);
      const index = tiers.length;
      await user.type(
        form.getByLabelText(
          `Input (USD per million tokens) – tier ${String(index)}`,
        ),
        "1",
      );
      await user.type(
        form.getByLabelText(
          `Output (USD per million tokens) – tier ${String(index)}`,
        ),
        "2",
      );
    }

    await user.click(
      form.getByRole("button", { name: "Save corrected price" }),
    );

    expect(
      await form.findByText("A tier must start above the one before it."),
    ).toBeTruthy();
    expect(api.correctPrice).not.toHaveBeenCalled();

    await user.click(form.getByRole("button", { name: "Remove tier 2" }));
    await user.click(
      form.getByRole("button", { name: "Save corrected price" }),
    );

    await waitFor(() => expect(api.correctPrice).toHaveBeenCalledTimes(1));
    const sent = api.correctPrice.mock.calls[0] as unknown as [
      unknown,
      string,
      { tiers: Array<{ contextOver: number; input: string }> },
    ];
    expect(sent[2].tiers).toMatchObject([
      { contextOver: 200000, input: "1000000" },
    ]);
  });

  // #554-T03
  it("adds and removes the older price over 200k tokens", async () => {
    const { user, form } = await openForm();

    await user.click(
      form.getByRole("button", {
        name: "Add the older price over 200k tokens",
      }),
    );
    expect(
      form.getByLabelText("Input (USD per million tokens) – over 200k tokens"),
    ).toBeTruthy();
    await user.click(
      form.getByRole("button", { name: "Remove the price over 200k tokens" }),
    );

    expect(
      form.queryByLabelText(
        "Input (USD per million tokens) – over 200k tokens",
      ),
    ).toBeNull();
  });

  // #554-T04
  it("shows the reason of a refusal by the route as a sentence and keeps what was typed", async () => {
    const { user, form } = await openForm(
      model(),
      fakeApi({
        ok: false,
        status: 422,
        code: "price_invalid",
        issues: [{ field: "price", code: "price_invalid" }],
      }),
    );
    await user.type(form.getByLabelText("Reason"), "Invoice.");

    await user.click(
      form.getByRole("button", { name: "Save corrected price" }),
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /The price is not valid/,
    );
    expect((form.getByLabelText("Reason") as HTMLInputElement).value).toBe(
      "Invoice.",
    );
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  // #554-T04
  it("starts the form again from the new price when the price moved under it", async () => {
    const view = model();
    const { rerender } = render(<ModelActions model={view} api={fakeApi()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Review price of/ }));
    await user.click(
      await screen.findByRole("button", { name: "Correct price" }),
    );
    expect(
      (
        screen.getByLabelText(
          "Input (USD per million tokens)",
        ) as HTMLInputElement
      ).value,
    ).toBe("0.6");

    const moved = model({
      price: {
        ...view.price,
        reference: {
          book: book("900000", "1900000"),
          hash: "v2:moved",
          sources: CATALOG_SOURCES,
        },
      },
    });
    rerender(<ModelActions model={moved} api={fakeApi()} />);

    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "Input (USD per million tokens)",
          ) as HTMLInputElement
        ).value,
      ).toBe("0.9"),
    );
  });
});
