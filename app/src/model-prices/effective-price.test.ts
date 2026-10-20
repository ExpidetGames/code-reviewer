// SPDX-License-Identifier: Apache-2.0

// The effective price of a model (#549, part C), as a pure function of the models.dev row, the override file and the
// admin's latest confirmation: the precedence admin correction over override over models.dev, and the status that
// decides whether the managed key may use the model.
import { describe, expect, it } from "vitest";
import type { ModelCost } from "../models-dev/parse.ts";
import { effectivePrice } from "./effective-price.ts";
import type { ModelOverride } from "./overrides.ts";
import { priceBookFromCatalog, type PriceBook } from "./price-book.ts";
import { referenceHash } from "./price-hash.ts";
import type { PriceConfirmation } from "./confirmation.ts";

const COST: ModelCost = {
  input: "2",
  output: "10",
  cacheRead: "0.1",
  cacheWrite: "2.5",
};
const OVERRIDE: ModelOverride = {
  reason: "No 1-hour price upstream.",
  cacheWrite1h: 4_000_000n,
  retiresNotBefore: null,
  blocked: false,
};

function confirmationOf(
  cost: ModelCost | null,
  override: ModelOverride | undefined,
  patch: Partial<PriceConfirmation> = {},
): PriceConfirmation {
  const reference = priceBookFromCatalog(
    cost,
    override?.cacheWrite1h ?? undefined,
  );
  return {
    id: 1,
    providerId: "anthropic",
    modelId: "claude-sonnet-5-5",
    source: "catalog",
    book: reference as PriceBook,
    reference,
    referenceHash: referenceHash(reference),
    reason: null,
    confirmedBy: "admin-1",
    confirmedAt: "2026-10-20T09:00:00.000Z",
    ...patch,
  };
}

describe("effectivePrice", () => {
  // #549-T02
  it("is unconfirmed until an admin confirms, and then proposes the catalog price with its sources", () => {
    const price = effectivePrice({
      cost: COST,
      override: OVERRIDE,
      confirmation: null,
    });

    expect(price.status).toBe("unconfirmed");
    expect(price.book).toMatchObject({
      input: 2_000_000n,
      output: 10_000_000n,
      cacheRead: 100_000n,
      cacheWrite5m: 2_500_000n,
      cacheWrite1h: 4_000_000n,
    });
    expect(price.sources).toEqual({
      input: "catalog",
      output: "catalog",
      cacheRead: "catalog",
      cacheWrite5m: "catalog",
      cacheWrite1h: "override",
      tiers: null,
    });
    expect(price.confirmation).toBeNull();
    expect(price.reference.hash).toBe(referenceHash(price.reference.book));
  });

  // #549-T02
  it("is confirmed only with a confirmation row, and then prices from what was confirmed", () => {
    const confirmation = confirmationOf(COST, OVERRIDE);

    const price = effectivePrice({
      cost: COST,
      override: OVERRIDE,
      confirmation,
    });

    expect(price.status).toBe("confirmed");
    expect(price.book).toEqual(confirmation.book);
    expect(price.confirmation).toBe(confirmation);
  });

  // #549-T02
  it("prefers the admin's correction to the override and the catalog, field by field", () => {
    const reference = priceBookFromCatalog(
      COST,
      OVERRIDE.cacheWrite1h ?? undefined,
    ) as PriceBook;
    const corrected: PriceBook = {
      ...reference,
      input: 3_000_000n,
      cacheWrite1h: 5_000_000n,
    };
    const confirmation = confirmationOf(COST, OVERRIDE, {
      source: "admin",
      book: corrected,
      reason: "Invoice of October.",
    });

    const price = effectivePrice({
      cost: COST,
      override: OVERRIDE,
      confirmation,
    });

    expect(price.status).toBe("confirmed");
    expect(price.book?.input).toBe(3_000_000n);
    expect(price.book?.output).toBe(10_000_000n);
    expect(price.book?.cacheWrite1h).toBe(5_000_000n);
    expect(price.sources).toMatchObject({
      input: "admin",
      output: "catalog",
      cacheWrite1h: "admin",
    });
  });

  // #549-T02
  it("prefers the override to the catalog for the 1-hour cache write", () => {
    const price = effectivePrice({
      cost: COST,
      override: { ...OVERRIDE, cacheWrite1h: 6_000_000n },
      confirmation: null,
    });

    expect(price.book?.cacheWrite1h).toBe(6_000_000n);
    expect(price.sources?.cacheWrite1h).toBe("override");
  });

  // #549-T03
  it("leaves the 1-hour cache write unpriced without an override", () => {
    const price = effectivePrice({
      cost: COST,
      override: undefined,
      confirmation: null,
    });

    expect(price.book?.cacheWrite1h).toBeNull();
    expect(price.sources?.cacheWrite1h).toBeNull();
  });

  // #549-T05
  it("is stale when the catalog price changed after the confirmation, and shows both prices", () => {
    const confirmation = confirmationOf(COST, OVERRIDE);
    const moved: ModelCost = { ...COST, input: "2.2" };

    const price = effectivePrice({
      cost: moved,
      override: OVERRIDE,
      confirmation,
    });

    expect(price.status).toBe("stale");
    expect(price.book?.input).toBe(2_000_000n);
    expect(price.reference.book?.input).toBe(2_200_000n);
    expect(price.confirmation?.book.input).toBe(2_000_000n);
  });

  // #549-T05
  it.each([
    ["the output price", { output: "11" }],
    ["the cache read price", { cacheRead: "0.2" }],
    ["the cache write price", { cacheWrite: "3" }],
    ["a tier", { tiers: [{ contextOver: 200000, input: "4", output: "20" }] }],
  ])("is stale when %s changes", (_name, change) => {
    const confirmation = confirmationOf(COST, OVERRIDE);

    const price = effectivePrice({
      cost: { ...COST, ...change },
      override: OVERRIDE,
      confirmation,
    });

    expect(price.status).toBe("stale");
  });

  // #549-T05
  it("is stale when the override's price changes after the confirmation", () => {
    const confirmation = confirmationOf(COST, OVERRIDE);

    const price = effectivePrice({
      cost: COST,
      override: { ...OVERRIDE, cacheWrite1h: 4_500_000n },
      confirmation,
    });

    expect(price.status).toBe("stale");
  });

  // #549-T05
  it("stays confirmed when the catalog price returns to the confirmed one", () => {
    const confirmation = confirmationOf(COST, OVERRIDE);

    expect(
      effectivePrice({ cost: { ...COST }, override: OVERRIDE, confirmation })
        .status,
    ).toBe("confirmed");
  });

  // #549-T05
  it("keeps an admin's correction stale when the catalog changed, because the admin priced against the old reference", () => {
    const reference = priceBookFromCatalog(COST, undefined) as PriceBook;
    const confirmation = confirmationOf(COST, undefined, {
      source: "admin",
      book: { ...reference, input: 3_000_000n },
      reason: "Invoice.",
    });

    const price = effectivePrice({
      cost: { ...COST, input: "2.5" },
      override: undefined,
      confirmation,
    });

    expect(price.status).toBe("stale");
    expect(price.book?.input).toBe(3_000_000n);
  });

  // #549-T02
  it("is unpriced when the catalog states no price and nobody has stated one", () => {
    const price = effectivePrice({
      cost: null,
      override: undefined,
      confirmation: null,
    });

    expect(price.status).toBe("unpriced");
    expect(price.book).toBeNull();
    expect(price.sources).toBeNull();
    expect(price.reference.book).toBeNull();
  });

  // #549-T02
  it("is unpriced when the catalog's price cannot be held exactly", () => {
    const price = effectivePrice({
      cost: { input: "0.0000001", output: "1" },
      override: undefined,
      confirmation: null,
    });

    expect(price.status).toBe("unpriced");
  });

  // #549-T02
  it("lets an admin price a model the catalog does not price, and calls it stale when the catalog starts to", () => {
    const book = priceBookFromCatalog(COST, undefined) as PriceBook;
    const confirmation = confirmationOf(null, undefined, {
      source: "admin",
      book,
      reference: null,
      reason: "Price of the provider's page.",
    });

    expect(
      effectivePrice({ cost: null, override: undefined, confirmation }).status,
    ).toBe("confirmed");
    expect(
      effectivePrice({ cost: COST, override: undefined, confirmation }).status,
    ).toBe("stale");
  });
});

describe("referenceHash", () => {
  // #549-T04
  it("is one value for equal books and another for any change, and for no book", () => {
    const a = priceBookFromCatalog(COST, 4_000_000n);
    const b = priceBookFromCatalog({ ...COST }, 4_000_000n);
    const c = priceBookFromCatalog({ ...COST, output: "10.5" }, 4_000_000n);

    expect(referenceHash(a)).toBe(referenceHash(b));
    expect(referenceHash(a)).not.toBe(referenceHash(c));
    expect(referenceHash(null)).not.toBe(referenceHash(a));
    expect(referenceHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
