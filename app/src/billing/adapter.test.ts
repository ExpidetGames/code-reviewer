// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BILLING_ADAPTER_ERROR_CODES,
  BILLING_EVENT_OUTCOMES,
  BILLING_EVENT_TYPES,
  BILLING_WEBHOOK_REJECTION_CODES,
  BillingAdapterError,
  TOP_UP_MAX_MICRO_USD,
  TOP_UP_MIN_MICRO_USD,
  assertTopUpAmount,
  assertValidCapabilities,
  createAdapterRegistry,
  isProviderRef,
  isUsdAmount,
  validateBillingEvent,
  type BillingAdapter,
  type BillingCapabilities,
  type BillingEvent,
} from "./adapter.ts";

const USD = 1_000_000;

const CAPABILITIES: BillingCapabilities = {
  merchantOfRecord: true,
  customAmount: true,
  partialRefund: true,
  minTopUp: 10 * USD,
  maxTopUp: 500 * USD,
  currencies: ["usd"],
  providerMayRefund: { windowDays: 60 },
  requiresBillingProfile: true,
  receiptsFrom: "provider",
};

function adapterWith(
  id: string,
  capabilities: BillingCapabilities = CAPABILITIES,
): BillingAdapter {
  return {
    id,
    capabilities,
    ensureCustomer: () => Promise.resolve(null),
    createTopUpCheckout: () =>
      Promise.resolve({
        checkout: { kind: "none" },
        session: null,
        payment: null,
      }),
  };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof BillingAdapterError ? error.code : "other";
  }
  return undefined;
}

describe("the code constants", () => {
  // #497-T13
  it("states the top-up range of ADR 0006 in micro-USD", () => {
    expect(TOP_UP_MIN_MICRO_USD).toBe(10 * USD);
    expect(TOP_UP_MAX_MICRO_USD).toBe(500 * USD);
  });

  // #497-T13
  it("keeps every set of codes unique and in snake case", () => {
    for (const set of [
      BILLING_ADAPTER_ERROR_CODES,
      BILLING_WEBHOOK_REJECTION_CODES,
      BILLING_EVENT_OUTCOMES,
      BILLING_EVENT_TYPES,
    ]) {
      expect(new Set(set).size).toBe(set.length);
      for (const code of set)
        expect(code).toMatch(/^[a-z]+(_[a-z]+)*$|^[a-z]+\.[a-z]+$/);
    }
  });

  // #497-T13
  it("names the outcomes of the issue", () => {
    expect(BILLING_EVENT_OUTCOMES).toEqual(
      expect.arrayContaining([
        "applied",
        "duplicate_ignored",
        "stale_ignored",
        "intent_unresolved",
        "ignored_type",
      ]),
    );
  });
});

describe("amounts and references", () => {
  // #497-T13
  it("accepts only positive safe integers as an amount", () => {
    expect(isUsdAmount(1)).toBe(true);
    expect(isUsdAmount(25 * USD)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, "5", null])
      expect(isUsdAmount(bad), String(bad)).toBe(false);
  });

  // #497-T13
  it("accepts an opaque id and nothing that looks like data", () => {
    for (const good of ["pi_3Abc", "re_1", "evt_x.y-z:1", "A"])
      expect(isProviderRef(good), good).toBe(true);
    for (const bad of [
      "",
      " pi_1",
      "pi 1",
      "pi_1\n",
      "a@b.de",
      "x".repeat(256),
      "<script>",
      7,
      null,
    ])
      expect(isProviderRef(bad), String(bad)).toBe(false);
  });
});

describe("the capabilities of an adapter", () => {
  // #497-T13
  it("lets an adapter narrow the range but never widen it", () => {
    expect(() => assertValidCapabilities("a", CAPABILITIES)).not.toThrow();
    expect(() =>
      assertValidCapabilities("a", {
        ...CAPABILITIES,
        minTopUp: 20 * USD,
        maxTopUp: 100 * USD,
      }),
    ).not.toThrow();

    const widened: Array<Partial<BillingCapabilities>> = [
      { minTopUp: 5 * USD },
      { maxTopUp: 501 * USD },
      { minTopUp: 100 * USD, maxTopUp: 50 * USD },
      { minTopUp: 10.5 * USD + 0.5 },
      { maxTopUp: Number.NaN },
      { currencies: [] },
      { currencies: ["eur"] as never },
      { providerMayRefund: { windowDays: 0 } },
    ];
    for (const change of widened)
      expect(
        codeOf(() =>
          assertValidCapabilities("a", { ...CAPABILITIES, ...change }),
        ),
        JSON.stringify(change),
      ).toBe("capabilities_invalid");
  });

  // #497-T13
  it("checks an amount against the range of the adapter and the code constants", () => {
    expect(() => assertTopUpAmount(CAPABILITIES, 10 * USD)).not.toThrow();
    expect(() => assertTopUpAmount(CAPABILITIES, 500 * USD)).not.toThrow();
    for (const bad of [
      10 * USD - 1,
      500 * USD + 1,
      0,
      -5 * USD,
      25.5,
      Number.NaN,
    ])
      expect(
        codeOf(() => assertTopUpAmount(CAPABILITIES, bad)),
        String(bad),
      ).toBe("amount_out_of_range");
    const narrow = { ...CAPABILITIES, minTopUp: 20 * USD, maxTopUp: 30 * USD };
    expect(codeOf(() => assertTopUpAmount(narrow, 19 * USD))).toBe(
      "amount_out_of_range",
    );
    expect(() => assertTopUpAmount(narrow, 25 * USD)).not.toThrow();
  });
});

describe("the registry", () => {
  // #497-T13
  it("is keyed by adapter id and refuses a second adapter with the same id", () => {
    const registry = createAdapterRegistry([
      adapterWith("one"),
      adapterWith("two"),
    ]);
    expect(registry.get("one")?.id).toBe("one");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.ids()).toEqual(["one", "two"]);
    expect(
      codeOf(() =>
        createAdapterRegistry([adapterWith("one"), adapterWith("one")]),
      ),
    ).toBe("adapter_id_duplicate");
  });

  // #497-T13
  it("refuses an adapter whose capabilities widen the range or whose id is not an id", () => {
    expect(
      codeOf(() =>
        createAdapterRegistry([
          adapterWith("wide", { ...CAPABILITIES, maxTopUp: 1000 * USD }),
        ]),
      ),
    ).toBe("capabilities_invalid");
    expect(
      codeOf(() => createAdapterRegistry([adapterWith("Not An Id")])),
    ).toBe("adapter_id_invalid");
  });
});

describe("validating a normalized event", () => {
  const base = { eventId: "evt_1", occurredAt: "2026-10-19T08:00:00.000Z" };
  const succeeded: BillingEvent = {
    ...base,
    type: "payment.succeeded",
    intentId: "intent-1",
    payment: "pi_1",
    checkout: "cs_1",
    creditable: 25 * USD,
    gross: 30 * USD,
    tax: 5 * USD,
  };

  // #497-T13
  it("accepts a well formed event of every type", () => {
    const events: BillingEvent[] = [
      succeeded,
      { ...succeeded, checkout: null, tax: null, intentId: null },
      {
        ...base,
        type: "payment.failed",
        intentId: "intent-1",
        payment: "pi_1",
        checkout: null,
      },
      {
        ...base,
        type: "refund.updated",
        payment: "pi_1",
        refund: "re_1",
        amount: 5 * USD,
        initiatedBy: "provider",
        status: "approved",
      },
      {
        ...base,
        type: "dispute.updated",
        payment: "pi_1",
        dispute: "dp_1",
        amount: 25 * USD,
        status: "lost",
      },
      { ...base, type: "ignored" },
    ];
    for (const event of events)
      expect(() => validateBillingEvent(event), event.type).not.toThrow();
  });

  // #497-T13
  it("refuses an amount that is not a positive integer, a bad reference and a bad time", () => {
    const bad: Array<
      Partial<Extract<BillingEvent, { type: "payment.succeeded" }>>
    > = [
      { creditable: 0 },
      { creditable: -1 },
      { creditable: 1.5 },
      { gross: Number.NaN },
      { tax: -1 },
      { payment: "has space" },
      { payment: "" },
      { eventId: "" },
      { occurredAt: "yesterday" },
      { occurredAt: "" },
    ];
    for (const change of bad)
      expect(
        codeOf(() => validateBillingEvent({ ...succeeded, ...change })),
        JSON.stringify(change),
      ).toBe("event_invalid");
  });

  // #497-T13
  it("refuses a status that the application does not know", () => {
    expect(
      codeOf(() =>
        validateBillingEvent({
          ...base,
          type: "dispute.updated",
          payment: "pi_1",
          dispute: "dp_1",
          amount: 1,
          status: "under_review" as never,
        }),
      ),
    ).toBe("event_invalid");
    expect(
      codeOf(() => validateBillingEvent({ ...base, type: "mystery" } as never)),
    ).toBe("event_invalid");
  });
});
