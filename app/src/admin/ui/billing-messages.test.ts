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
  describeStripeDetail,
} from "./billing-messages.ts";
import { getProductIdentity } from "../../product-identity/current.ts";

const PRODUCT = getProductIdentity();

describe("the copy for the billing codes", () => {
  // #504-T09
  it.each(BILLING_ERROR_CODES)(
    "has a sentence of its own for the error %s, which is not the code",
    (code) => {
      const sentence = describeBillingFailure(PRODUCT, code);

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
    const sentence = describeBillingFailure(
     PRODUCT,
      "webhook_endpoint_unusable",
    );

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
    expect(describeBillingFailure(PRODUCT, "something_new")).toBe(
      GENERIC_FAILURE,
    );
    expect(describeBillingIssue({ field: "x", code: "something_new" })).toBe(
      GENERIC_FAILURE,
    );
    expect(describeMissingItem("something_new")).toBe(GENERIC_FAILURE);
  });

  // #504-T09
  it("translates the transport failures like the other pages do", () => {
    expect(describeBillingFailure(PRODUCT, "NETWORK_ERROR")).not.toBe(
      GENERIC_FAILURE,
    );
    expect(describeBillingFailure(PRODUCT, "UNAUTHENTICATED")).not.toBe(
      GENERIC_FAILURE,
    );
  });

  // #504-T12
  it("names no vendor of the removed design and no plan", () => {
    const all = [
      ...BILLING_ERROR_CODES.map((code) => describeBillingFailure(PRODUCT, code)),
      ...BILLING_ISSUE_CODES.map((code) =>
        describeBillingIssue({ field: "x", code }),
      ),
    ].join(" ");

    expect(all.toLowerCase()).not.toContain(["pad", "dle"].join(""));
    expect(all).not.toMatch(/\bplans?\b/i);
  });
});

describe("the copy for a failed Stripe check (#690)", () => {
  // #690-T04
  it("says in so many words that the account is not enabled for Managed Payments", () => {
    const sentence = describeBillingFailure(
     PRODUCT,
      "stripe_managed_payments_unavailable",
    );

    expect(sentence).toMatch(/not enabled for Managed Payments/);
  });

  // #690-T03
  it("names the HTTP status of an answer the page cannot read", () => {
    expect(describeBillingFailure(PRODUCT, "UNEXPECTED_RESPONSE", 502)).toBe(
      "The server answered with HTTP 502. Reload the page and try again.",
    );
  });

  // #690-T01
  it("shows what Stripe said as plain identifiers, and nothing else", () => {
    expect(
      describeStripeDetail({
        status: 400,
        code: "parameter_invalid_empty",
        type: "invalid_request_error",
      }),
    ).toBe(
      " Stripe said: HTTP 400, invalid_request_error, parameter_invalid_empty.",
    );
    expect(describeStripeDetail({ status: 500, code: null, type: null })).toBe(
      " Stripe said: HTTP 500.",
    );
    expect(describeStripeDetail({ status: null, code: null, type: null })).toBe(
      "",
    );
    expect(describeStripeDetail(undefined)).toBe("");
    expect(describeStripeDetail("sk_test_secret")).toBe("");
    expect(
      describeStripeDetail({ status: 400, code: "<script>", type: "x y" }),
    ).toBe(" Stripe said: HTTP 400.");
  });
});
