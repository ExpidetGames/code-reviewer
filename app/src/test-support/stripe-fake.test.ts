// SPDX-License-Identifier: Apache-2.0

// The parts of the fake Stripe (fakes/stripe) that are pure: the reading of a form body, the shapes it is built from and
// the signer. The server itself is exercised in src/billing/stripe-fake*.integration.test.ts.
import { describe, expect, it } from "vitest";
import { canonicalize, parseForm } from "../../../fakes/stripe/form.ts";
import {
  STRIPE_FIXTURE_NAMES,
  loadStripeFixture,
} from "../../../fakes/stripe/fixtures.ts";
import { signStripeWebhook } from "../../../fakes/stripe/webhooks.ts";
import {
  stripeAccountSchema,
  stripeChargeSchema,
  stripeCheckoutSessionSchema,
  stripeCustomerSchema,
  stripeInvoiceSchema,
  stripePaymentIntentSchema,
  stripeRefundSchema,
  stripeTaxIdSchema,
  stripeWebhookEndpointSchema,
} from "../billing/stripe-schemas.ts";

describe("the form reader of the fake", () => {
  // #500-T01
  it("reads objects, lists and scalars like Stripe does", () => {
    expect(
      parseForm(
        "name=A%26B&address[city]=Berlin&line_items[0][quantity]=1&line_items[1][quantity]=2&tags[]=x&tags[]=y&metadata[k]=v",
      ),
    ).toEqual({
      name: "A&B",
      address: { city: "Berlin" },
      line_items: [{ quantity: "1" }, { quantity: "2" }],
      tags: ["x", "y"],
      metadata: { k: "v" },
    });
  });

  // #500-T01
  it("keeps the last of a repeated scalar and returns nothing for an empty body", () => {
    expect(parseForm("a=1&a=2")).toEqual({ a: "2" });
    expect(parseForm("")).toEqual({});
  });

  // #500-T01
  it("refuses a key it cannot read and the names that would reach the prototype", () => {
    for (const body of [
      "a[=1",
      "a]b=1",
      "[x]=1",
      "__proto__[x]=1",
      "a[constructor]=1",
      "a[prototype][b]=1",
    ])
      expect(() => parseForm(body), body).toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  // #500-T02
  it("tells two requests apart by their parameters and not by the order of the keys", () => {
    expect(canonicalize(parseForm("a=1&b[c]=2&b[d]=3"))).toBe(
      canonicalize(parseForm("b[d]=3&b[c]=2&a=1")),
    );
    expect(canonicalize(parseForm("a=1"))).not.toBe(
      canonicalize(parseForm("a=2")),
    );
    expect(canonicalize(parseForm("l[0]=a&l[1]=b"))).not.toBe(
      canonicalize(parseForm("l[0]=b&l[1]=a")),
    );
  });
});

describe("the shapes of the fake", () => {
  // #500-T01
  it("are read by the schemas of the client: every fixture the fake builds an answer from parses", () => {
    const fixtures: Array<
      [
        (typeof STRIPE_FIXTURE_NAMES)[number],
        { safeParse: (v: unknown) => { success: boolean } },
      ]
    > = [
      ["account", stripeAccountSchema],
      ["charge", stripeChargeSchema],
      ["checkout-session", stripeCheckoutSessionSchema],
      ["customer", stripeCustomerSchema],
      ["invoice", stripeInvoiceSchema],
      ["payment-intent", stripePaymentIntentSchema],
      ["refund", stripeRefundSchema],
      ["tax-id", stripeTaxIdSchema],
      ["webhook-endpoint", stripeWebhookEndpointSchema],
    ];
    for (const [name, schema] of fixtures)
      expect(schema.safeParse(loadStripeFixture(name)).success, name).toBe(
        true,
      );
  });

  // #500-T01
  it("are copies: changing one leaves the file as it is", () => {
    const first = loadStripeFixture("customer");
    first.name = "changed";
    expect(loadStripeFixture("customer").name).toBeNull();
  });

  // #500-T01
  it("contain only dummy data: no key, no real address, no email", () => {
    for (const name of STRIPE_FIXTURE_NAMES) {
      const text = JSON.stringify(loadStripeFixture(name));
      expect(text, name).not.toMatch(
        /sk_(test|live)_|rk_(test|live)_|whsec_[A-Za-z0-9]{10}/,
      );
      expect(text, name).not.toMatch(/@[a-z0-9-]+\.(com|de|net|org)/i);
    }
  });
});

describe("the signer of the fake", () => {
  // #500-T10
  it("makes the signature that openssl makes for the same bytes", () => {
    const body =
      '{"id":"evt_test_1","object":"event","type":"charge.refunded"}';
    // `printf '1700000000.%s' "$body" | openssl dgst -sha256 -hmac whsec_test_secret_value`
    expect(
      signStripeWebhook(body, "whsec_test_secret_value", 1_700_000_000),
    ).toBe(
      "t=1700000000,v1=a50bbd80590d7bc4488992e121364b36ce1bc32bcfb88b45ece13140626ec41a",
    );
  });
});
