// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the billing page: one sentence for every stable code the billing routes answer (the codes are the contract, the
// sentences are what the page shows), for every refused field and for every item that keeps billing from being switched on.
import { describe, expect, it } from "vitest";
import {
  BILLING_ERROR_CODES,
  BILLING_ISSUE_CODES,
} from "../../billing/admin-errors.ts";
import { BILLING_MISSING_ITEMS } from "../../billing/readiness.ts";
import { GENERIC_FAILURE } from "../../ui/transport-messages.ts";
import {
  describeBillingFailure,
  describeBillingIssue,
  describeMissingItem,
} from "./billing-messages.ts";

describe("the copy for the billing codes", () => {
  // #504-T09
  it.each(BILLING_ERROR_CODES)(
    "has a sentence of its own for the error %s, which is not the code",
    (code) => {
      const sentence = describeBillingFailure(code);

      expect(sentence).not.toBe(GENERIC_FAILURE);
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).not.toContain(code);
      expect(sentence).toMatch(/[.!?]$/);
    },
  );

  // #504-T09
  it.each(BILLING_ISSUE_CODES)(
    "has a sentence of its own for the refused field with the code %s",
    (code) => {
      const sentence = describeBillingIssue({ field: "x", code });

      expect(sentence).not.toBe(GENERIC_FAILURE);
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).not.toContain(code);
    },
  );

  // #595
  it("tells to switch billing off before the unusable webhook endpoint is replaced, as replacing is refused while billing is on", () => {
    const sentence = describeBillingFailure("webhook_endpoint_unusable");

    expect(sentence).toMatch(/Switch billing off, then replace it/);
    expect(sentence).not.toMatch(/Replace the endpoint here/);
  });

  // #504-T03
  it.each([...BILLING_MISSING_ITEMS, "connection_check_failed"])(
    "has a line for the missing item %s",
    (item) => {
      const line = describeMissingItem(item);

      expect(line.length).toBeGreaterThan(8);
      expect(line).not.toContain(item);
    },
  );

  // #498-T19
  it("names the Dispatcher without vm_lifecycle as what keeps billing from being switched on", () => {
    const line = describeMissingItem("dispatcher_lacks_vm_lifecycle");

    expect(line).not.toBe(GENERIC_FAILURE);
    expect(line).toMatch(/Dispatcher/);
    expect(line).not.toContain("dispatcher_lacks_vm_lifecycle");
  });

  // #504-T09
  it("falls back to the generic sentence for a code it does not know, and says nothing of it", () => {
    expect(describeBillingFailure("something_new")).toBe(GENERIC_FAILURE);
    expect(describeBillingIssue({ field: "x", code: "something_new" })).toBe(
      GENERIC_FAILURE,
    );
    expect(describeMissingItem("something_new")).toBe(GENERIC_FAILURE);
  });

  // #504-T09
  it("translates the transport failures like the other pages do", () => {
    expect(describeBillingFailure("NETWORK_ERROR")).not.toBe(GENERIC_FAILURE);
    expect(describeBillingFailure("UNAUTHENTICATED")).not.toBe(GENERIC_FAILURE);
  });

  // #504-T12
  it("names no vendor of the removed design and no plan", () => {
    const all = [
      ...BILLING_ERROR_CODES.map(describeBillingFailure),
      ...BILLING_ISSUE_CODES.map((code) =>
        describeBillingIssue({ field: "x", code }),
      ),
    ].join(" ");

    expect(all.toLowerCase()).not.toContain(["pad", "dle"].join(""));
    expect(all).not.toMatch(/\bplans?\b/i);
  });
});
