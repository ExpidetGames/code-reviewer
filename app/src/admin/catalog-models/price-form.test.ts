// SPDX-License-Identifier: LicenseRef-Proprietary

// The form of a price correction (#554): dollars per million tokens typed as decimals become whole micro-USD without a
// float, a field that is not a price is named, tiers must go up, and a reason is required. The book it makes is exactly
// what the route takes (`parsePriceBookJson`).
import { describe, expect, it } from "vitest";
import { MAX_REASON_LENGTH } from "../../model-prices/service.ts";
import {
  MAX_PRICE_TIERS,
  parsePriceBookJson,
  type PriceBookJson,
} from "../../model-prices/price-book.ts";
import {
  PRICE_FORM_MAX_REASON,
  PRICE_FORM_MAX_TIERS,
  bookFromForm,
  emptyLevelForm,
  formFromBook,
  hasFreeAmount,
  type PriceForm,
} from "./price-form.ts";

const BOOK: PriceBookJson = {
  input: "2500000",
  output: "10000000",
  cacheRead: "250000",
  cacheWrite5m: "3125000",
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
  contextOver200k: null,
  tiers: [],
};

function form(changes: Partial<PriceForm> = {}): PriceForm {
  return { ...formFromBook(BOOK), reason: "Invoice of October.", ...changes };
}

describe("the form of a book", () => {
  // #554-T03
  it("shows the amounts of a book as exact dollars and leaves an unpriced field empty", () => {
    const shown = formFromBook(BOOK);

    expect(shown).toMatchObject({
      input: "2.5",
      output: "10",
      cacheRead: "0.25",
      cacheWrite5m: "3.125",
      cacheWrite1h: "",
      reasoning: "",
      contextOver200k: null,
      tiers: [],
      reason: "",
    });
  });

  // #554-T03
  it("starts empty for a model that has no price", () => {
    expect(formFromBook(null)).toEqual({
      ...emptyLevelForm(),
      contextOver200k: null,
      tiers: [],
      reason: "",
      freeConfirmed: false,
    });
  });

  // #554-T03
  it("carries the tiers and the older tier of a book", () => {
    const level = {
      input: "2500000",
      output: "10000000",
      cacheRead: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
      inputAudio: null,
      outputAudio: null,
    };

    const shown = formFromBook({
      ...BOOK,
      contextOver200k: level,
      tiers: [{ contextOver: 100000, ...level }],
    });

    expect(shown.contextOver200k?.input).toBe("2.5");
    expect(shown.tiers).toHaveLength(1);
    expect(shown.tiers[0]).toMatchObject({
      contextOver: "100000",
      input: "2.5",
    });
  });
});

describe("the book of a form", () => {
  // #554-T03
  it("converts dollars to whole micro-USD exactly and sends the source of truth the route takes", () => {
    const result = bookFromForm(
      form({ input: "0.1", output: "0.3", cacheRead: "0.000001" }),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.price).toMatchObject({
      input: "100000",
      output: "300000",
      cacheRead: "1",
      cacheWrite1h: null,
    });
    expect(parsePriceBookJson(result.price).ok).toBe(true);
    expect(result.reason).toBe("Invoice of October.");
  });

  // #554-T03
  it("does not take a float's word for a price: 0.1 + 0.2 style decimals stay exact", () => {
    const result = bookFromForm(
      form({ input: "0.30000000", output: "19.999999" }),
    );

    expect(result).toMatchObject({
      ok: true,
      price: { input: "300000", output: "19999999" },
    });
  });

  // #554-T03
  it.each([
    ["-1", "negative"],
    ["-0.5", "negative"],
    ["abc", "not_a_price"],
    ["1e3", "not_a_price"],
    ["2,5", "not_a_price"],
    ["0.0000001", "not_a_price"],
    ["100001", "not_a_price"],
    ["", "required"],
  ])("refuses %j as the input price with %s", (text, code) => {
    const result = bookFromForm(form({ input: text }));

    expect(result).toEqual({ ok: false, issues: [{ field: "input", code }] });
  });

  // #554-T03
  it("requires an output price and treats an empty optional field as not priced, never as zero", () => {
    const missing = bookFromForm(form({ output: "  " }));
    const free = bookFromForm(form({ cacheRead: "0" }));

    expect(missing).toEqual({
      ok: false,
      issues: [{ field: "output", code: "required" }],
    });
    expect(free).toMatchObject({ ok: true, price: { cacheRead: "0" } });
  });

  // #554-T03
  it("names every field that is wrong, not only the first", () => {
    const result = bookFromForm(
      form({ input: "x", output: "-2", reasoning: "y" }),
    );

    expect(result).toEqual({
      ok: false,
      issues: [
        { field: "input", code: "not_a_price" },
        { field: "output", code: "negative" },
        { field: "reasoning", code: "not_a_price" },
      ],
    });
  });

  // #554-T03
  it("requires tiers to go up in context size", () => {
    const level = { ...emptyLevelForm(), input: "1", output: "2" };
    const up = bookFromForm(
      form({
        tiers: [
          { ...level, contextOver: "100000" },
          { ...level, contextOver: "200000" },
        ],
      }),
    );
    const flat = bookFromForm(
      form({
        tiers: [
          { ...level, contextOver: "200000" },
          { ...level, contextOver: "200000" },
        ],
      }),
    );
    const down = bookFromForm(
      form({
        tiers: [
          { ...level, contextOver: "200000" },
          { ...level, contextOver: "100000" },
        ],
      }),
    );

    expect(up).toMatchObject({ ok: true });
    expect(flat).toEqual({
      ok: false,
      issues: [{ field: "tiers.1.contextOver", code: "tiers_not_ascending" }],
    });
    expect(down).toEqual({
      ok: false,
      issues: [{ field: "tiers.1.contextOver", code: "tiers_not_ascending" }],
    });
  });

  // #554-T03
  it.each(["", "0", "-5", "1.5", "abc", "100000001"])(
    "refuses %j as the context size of a tier",
    (contextOver) => {
      const level = { ...emptyLevelForm(), input: "1", output: "2" };

      const result = bookFromForm(form({ tiers: [{ ...level, contextOver }] }));

      expect(result).toEqual({
        ok: false,
        issues: [
          { field: "tiers.0.contextOver", code: "tier_context_invalid" },
        ],
      });
    },
  );

  // #554-T03
  it("checks the prices of a tier and of the older tier like the base price", () => {
    const level = { ...emptyLevelForm(), input: "1", output: "2" };

    const result = bookFromForm(
      form({
        contextOver200k: { ...level, output: "" },
        tiers: [{ ...level, input: "-1", contextOver: "1000" }],
      }),
    );

    expect(result).toEqual({
      ok: false,
      issues: [
        { field: "contextOver200k.output", code: "required" },
        { field: "tiers.0.input", code: "negative" },
      ],
    });
  });

  // #554-T03
  it("accepts at most as many tiers as the book holds", () => {
    const level = { ...emptyLevelForm(), input: "1", output: "2" };
    const tiers = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...level,
        contextOver: String(i + 1),
      }));

    expect(bookFromForm(form({ tiers: tiers(MAX_PRICE_TIERS) })).ok).toBe(true);
    expect(bookFromForm(form({ tiers: tiers(MAX_PRICE_TIERS + 1) }))).toEqual({
      ok: false,
      issues: [{ field: "tiers", code: "too_many_tiers" }],
    });
  });

  // #554-T03
  it.each([
    ["", false],
    ["   ", false],
    ["Invoice.", true],
    ["x".repeat(PRICE_FORM_MAX_REASON), true],
    ["x".repeat(PRICE_FORM_MAX_REASON + 1), false],
    ["two\nlines", false],
    ["tab\there", false],
  ])("takes the reason %j: %s", (reason, accepted) => {
    const result = bookFromForm(form({ reason }));

    expect(result.ok).toBe(accepted);
    if (!accepted)
      expect(result).toEqual({
        ok: false,
        issues: [{ field: "reason", code: "reason_invalid" }],
      });
  });

  // #554-T03
  it("trims the reason it sends", () => {
    const result = bookFromForm(form({ reason: "  Invoice.  " }));

    expect(result).toMatchObject({ ok: true, reason: "Invoice." });
  });

  // #554-T03
  it("allows as long a reason and as many tiers as the route does", () => {
    expect(PRICE_FORM_MAX_REASON).toBe(MAX_REASON_LENGTH);
    expect(PRICE_FORM_MAX_TIERS).toBe(MAX_PRICE_TIERS);
  });

  // #554-T03
  it("shows a book and makes the same book again", () => {
    const original: PriceBookJson = {
      ...BOOK,
      cacheWrite1h: "5000000",
      reasoning: "10000000",
      inputAudio: "1500000",
      outputAudio: "9000000",
      contextOver200k: {
        input: "5000000",
        output: "15000000",
        cacheRead: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        reasoning: null,
        inputAudio: null,
        outputAudio: null,
      },
      tiers: [
        {
          contextOver: 272000,
          input: "5000000",
          output: "22500000",
          cacheRead: "500000",
          cacheWrite5m: null,
          cacheWrite1h: null,
          reasoning: null,
          inputAudio: null,
          outputAudio: null,
        },
      ],
    };

    const result = bookFromForm({ ...formFromBook(original), reason: "Same." });

    expect(result).toMatchObject({ ok: true, price: original });
    expect(parsePriceBookJson(result.ok ? result.price : null).ok).toBe(true);
  });
});

describe("a price of zero", () => {
  // #554-T03
  it.each(["0", "0.0", "0.000000", " 0 "])(
    "needs an explicit confirmation that the model is free when input is %j",
    (typed) => {
      const result = bookFromForm(form({ input: typed }));

      expect(result).toEqual({
        ok: false,
        issues: [{ field: "freeConfirmed", code: "free_not_confirmed" }],
      });
    },
  );

  // #554-T03
  it("needs it for output too, once however many fields are zero", () => {
    const result = bookFromForm(form({ input: "0", output: "0" }));

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "freeConfirmed", code: "free_not_confirmed" }],
    });
  });

  // #554-T03
  it("makes the book with the zero once the admin confirmed that it is free", () => {
    const result = bookFromForm(
      form({ input: "0", output: "0", freeConfirmed: true }),
    );

    expect(result).toMatchObject({
      ok: true,
      price: { input: "0", output: "0", cacheRead: "250000" },
    });
  });

  // #554-T03
  it("needs it for a zero in a tier or in the older price over 200k tokens, not for an optional field", () => {
    const tiered = form({
      tiers: [{ ...formFromBook(BOOK), contextOver: "200000", output: "0" }],
    });
    const older = form({
      contextOver200k: { ...emptyLevelForm(), input: "0", output: "1" },
    });

    for (const typed of [tiered, older])
      expect(bookFromForm(typed)).toMatchObject({
        ok: false,
        issues: [{ field: "freeConfirmed", code: "free_not_confirmed" }],
      });
    expect(bookFromForm(form({ cacheRead: "0" }))).toMatchObject({ ok: true });
  });

  // #554-T03
  it("does not ask when nothing is zero, and ignores a confirmation that was not needed", () => {
    expect(bookFromForm(form())).toMatchObject({ ok: true });
    expect(bookFromForm(form({ freeConfirmed: true }))).toMatchObject({
      ok: true,
    });
  });

  // #554-T03
  it("tells the form when to show the confirmation: when input or output of any level reads as zero", () => {
    expect(hasFreeAmount(form())).toBe(false);
    expect(hasFreeAmount(form({ input: "0.00" }))).toBe(true);
    expect(hasFreeAmount(form({ output: "0" }))).toBe(true);
    expect(hasFreeAmount(form({ cacheRead: "0" }))).toBe(false);
    expect(hasFreeAmount(form({ input: "" }))).toBe(false);
    expect(hasFreeAmount(form({ input: "abc" }))).toBe(false);
  });
});
