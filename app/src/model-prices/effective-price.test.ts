// SPDX-License-Identifier: Apache-2.0

// The effective price of a model (#549, part C), as a pure function of the models.dev row, the override file and the
// admin's latest confirmation: the precedence admin correction over override over models.dev, and the status that
// decides whether the managed key may use the model.
import { describe, expect, it } from "vitest";
import type { ModelCost } from "../models-dev/parse.ts";
import { effectivePrice } from "./effective-price.ts";
import type { ModelOverride } from "./overrides.ts";
import { priceBookFromCatalog, type PriceBook } from "./price-book.ts";
import { HASH_VERSION, hashVersionOf, referenceHash } from "./price-hash.ts";
import type { PriceConfirmation } from "./confirmation.ts";

const COST: ModelCost = {
  input: "2",
  output: "10",
  cacheRead: "0.1",
  cacheWrite: "2.5",
};
const OVERRIDE: ModelOverride = {
  reason: "No 1-hour price upstream.",
  cacheWrite1h: BigInt(4_000_000),
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
    referenceHash: referenceHash(reference, { reasoning: false }),
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
      reasoning: false,
      cost: COST,
      override: OVERRIDE,
      confirmation: null,
    });

    expect(price.status).toBe("unconfirmed");
    expect(price.book).toMatchObject({
      input: BigInt(2_000_000),
      output: BigInt(10_000_000),
      cacheRead: BigInt(100_000),
      cacheWrite5m: BigInt(2_500_000),
      cacheWrite1h: BigInt(4_000_000),
    });
    expect(price.sources).toEqual({
      input: "catalog",
      output: "catalog",
      cacheRead: "catalog",
      cacheWrite5m: "catalog",
      cacheWrite1h: "override",
      reasoning: null,
      inputAudio: null,
      outputAudio: null,
      contextOver200k: null,
      tiers: null,
    });
    expect(price.confirmation).toBeNull();
    expect(price.reference.hash).toBe(
      referenceHash(price.reference.book, { reasoning: false }),
    );
  });

  // #549-T02
  it("is confirmed only with a confirmation row, and then prices from what was confirmed", () => {
    const confirmation = confirmationOf(COST, OVERRIDE);

    const price = effectivePrice({
      reasoning: false,
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
      input: BigInt(3_000_000),
      cacheWrite1h: BigInt(5_000_000),
    };
    const confirmation = confirmationOf(COST, OVERRIDE, {
      source: "admin",
      book: corrected,
      reason: "Invoice of October.",
    });

    const price = effectivePrice({
      reasoning: false,
      cost: COST,
      override: OVERRIDE,
      confirmation,
    });

    expect(price.status).toBe("confirmed");
    expect(price.book?.input).toBe(BigInt(3_000_000));
    expect(price.book?.output).toBe(BigInt(10_000_000));
    expect(price.book?.cacheWrite1h).toBe(BigInt(5_000_000));
    expect(price.sources).toMatchObject({
      input: "admin",
      output: "catalog",
      cacheWrite1h: "admin",
    });
  });

  // #549-T02
  it("prefers the override to the catalog for the 1-hour cache write", () => {
    const price = effectivePrice({
      reasoning: false,
      cost: COST,
      override: { ...OVERRIDE, cacheWrite1h: BigInt(6_000_000) },
      confirmation: null,
    });

    expect(price.book?.cacheWrite1h).toBe(BigInt(6_000_000));
    expect(price.sources?.cacheWrite1h).toBe("override");
  });

  // #549-T03
  it("leaves the 1-hour cache write unpriced without an override", () => {
    const price = effectivePrice({
      reasoning: false,
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
      reasoning: false,
      cost: moved,
      override: OVERRIDE,
      confirmation,
    });

    expect(price.status).toBe("stale");
    expect(price.book?.input).toBe(BigInt(2_000_000));
    expect(price.reference.book?.input).toBe(BigInt(2_200_000));
    expect(price.confirmation?.book.input).toBe(BigInt(2_000_000));
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
      reasoning: false,
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
      reasoning: false,
      cost: COST,
      override: { ...OVERRIDE, cacheWrite1h: BigInt(4_500_000) },
      confirmation,
    });

    expect(price.status).toBe("stale");
  });

  // #549-T05
  it("stays confirmed when the catalog price returns to the confirmed one", () => {
    const confirmation = confirmationOf(COST, OVERRIDE);

    expect(
      effectivePrice({
        reasoning: false,
        cost: { ...COST },
        override: OVERRIDE,
        confirmation,
      }).status,
    ).toBe("confirmed");
  });

  // #549-T05
  it("keeps an admin's correction stale when the catalog changed, because the admin priced against the old reference", () => {
    const reference = priceBookFromCatalog(COST, undefined) as PriceBook;
    const confirmation = confirmationOf(COST, undefined, {
      source: "admin",
      book: { ...reference, input: BigInt(3_000_000) },
      reason: "Invoice.",
    });

    const price = effectivePrice({
      reasoning: false,
      cost: { ...COST, input: "2.5" },
      override: undefined,
      confirmation,
    });

    expect(price.status).toBe("stale");
    expect(price.book?.input).toBe(BigInt(3_000_000));
  });

  // #549-T02
  it("is unpriced when the catalog states no price and nobody has stated one", () => {
    const price = effectivePrice({
      reasoning: false,
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
      reasoning: false,
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
      effectivePrice({
        reasoning: false,
        cost: null,
        override: undefined,
        confirmation,
      }).status,
    ).toBe("confirmed");
    expect(
      effectivePrice({
        reasoning: false,
        cost: COST,
        override: undefined,
        confirmation,
      }).status,
    ).toBe("stale");
  });
});

describe("what makes a confirmation stale", () => {
  const reasoningCost: ModelCost = { ...COST, reasoning: "12" };
  const confirmedFor = (cost: ModelCost, reasoning: boolean) =>
    confirmationOf(cost, undefined, {
      referenceHash: referenceHash(priceBookFromCatalog(cost, undefined), {
        reasoning,
      }),
    });

  // #549-T05
  it("sees a changed price of reasoning tokens", () => {
    const confirmation = confirmedFor(reasoningCost, true);

    const same = effectivePrice({
      cost: reasoningCost,
      reasoning: true,
      override: undefined,
      confirmation,
    });
    const changed = effectivePrice({
      cost: { ...reasoningCost, reasoning: "14" },
      reasoning: true,
      override: undefined,
      confirmation,
    });

    expect(same.status).toBe("confirmed");
    expect(changed.status).toBe("stale");
  });

  // #549-T05
  it("sees a change of the reasoning flag of the model", () => {
    const confirmation = confirmedFor(COST, false);

    const price = effectivePrice({
      cost: COST,
      reasoning: true,
      override: undefined,
      confirmation,
    });

    expect(price.status).toBe("stale");
  });

  // #549-T05
  it("sees a changed audio price, a changed older 200k tier and a tier added late", () => {
    const base: ModelCost = {
      ...COST,
      tiers: Array.from({ length: 12 }, (_, index) => ({
        contextOver: (index + 1) * 1000,
        input: "3",
        output: "4",
      })),
    };
    const confirmation = confirmedFor(base, false);
    const statusOf = (cost: ModelCost) =>
      effectivePrice({
        cost,
        reasoning: false,
        override: undefined,
        confirmation,
      }).status;

    expect(statusOf(base)).toBe("confirmed");
    expect(statusOf({ ...base, inputAudio: "1" })).toBe("stale");
    expect(
      statusOf({ ...base, contextOver200k: { input: "3", output: "4" } }),
    ).toBe("stale");
    expect(
      statusOf({
        ...base,
        tiers: [
          ...(base.tiers ?? []).slice(0, 11),
          { contextOver: 12000, input: "3", output: "5" },
        ],
      }),
    ).toBe("stale");
  });

  // #549-T05
  it("is unpriced while the catalog states a price it cannot read, and stale for a model confirmed before", () => {
    const unreadable: ModelCost = { ...COST, unknown: ["cost.input_video"] };

    const fresh = effectivePrice({
      cost: unreadable,
      reasoning: false,
      override: undefined,
      confirmation: null,
    });
    const confirmed = effectivePrice({
      cost: unreadable,
      reasoning: false,
      override: undefined,
      confirmation: confirmedFor(COST, false),
    });

    expect(fresh.status).toBe("unpriced");
    expect(confirmed.status).toBe("stale");
  });

  // #549-T13
  it("counts a confirmation made with the first version of the hash as stale, however the price looks", () => {
    const current = referenceHash(priceBookFromCatalog(COST, undefined), {
      reasoning: false,
    });
    const confirmation = confirmationOf(COST, undefined, {
      referenceHash: current.replace(/^v2:/, ""),
    });

    const price = effectivePrice({
      cost: COST,
      reasoning: false,
      override: undefined,
      confirmation,
    });

    expect(price.status).toBe("stale");
    expect(hashVersionOf(confirmation.referenceHash)).toBe(1);
    expect(hashVersionOf(current)).toBe(HASH_VERSION);
  });
});

describe("referenceHash", () => {
  // #549-T04
  it("is one value for equal books and another for any change, and for no book", () => {
    const a = priceBookFromCatalog(COST, BigInt(4_000_000));
    const b = priceBookFromCatalog({ ...COST }, BigInt(4_000_000));
    const c = priceBookFromCatalog(
      { ...COST, output: "10.5" },
      BigInt(4_000_000),
    );

    const plain = { reasoning: false };
    expect(referenceHash(a, plain)).toBe(referenceHash(b, plain));
    expect(referenceHash(a, plain)).not.toBe(referenceHash(c, plain));
    expect(referenceHash(null, plain)).not.toBe(referenceHash(a, plain));
    expect(referenceHash(a, plain)).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(referenceHash(a, { reasoning: true })).not.toBe(
      referenceHash(a, plain),
    );
  });
});
