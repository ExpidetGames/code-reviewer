// SPDX-License-Identifier: Apache-2.0

// #659: the Stripe adapter lists the invoices of the workspace's customer, against the fake Stripe (fakes/stripe).
import { describe, expect, it } from "vitest";
import { BillingAdapterError, toUsd, type BillingProfile } from "./adapter.ts";
import {
  createStripeAdapter,
  STRIPE_CHECKOUT_PARAMETERS,
} from "./stripe-adapter.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";

const PROFILE: BillingProfile = {
  legalName: "Example GmbH",
  country: "DE",
  addressLines: ["Teststrasse 1"],
  postalCode: "10115",
  city: "Berlin",
  vatId: null,
  locale: "en",
};

async function start() {
  const fake = await startTestStripe();
  const adapter = createStripeAdapter({
    client: () => Promise.resolve(clientFor(fake)),
  });
  const customer = async (workspaceId: string) => {
    const id = await adapter.ensureCustomer({
      workspace: { id: workspaceId },
      profile: PROFILE,
      customer: null,
    });
    if (id === null) throw new Error("no customer");
    return id;
  };
  /** A top-up of `dollars` made and paid by the buyer of `customer`. */
  const topUp = async (customer: string, intentId: string, dollars: number) => {
    const started = await adapter.createTopUpCheckout({
      customer,
      intentId,
      amount: toUsd(dollars * 1_000_000),
      returnUrl: "http://localhost/w/a/settings/billing",
    });
    if (started.session === null) throw new Error("no session");
    return fake.buyer.pay(started.session);
  };
  return { fake, adapter, customer, topUp };
}

describe("the invoices of a workspace", () => {
  // #659-T02
  it("lists the invoice a paid top-up leaves, with its date, amount, status and the two Stripe addresses", async () => {
    const { adapter, customer, topUp } = await start();
    const mine = await customer("workspace-1");
    await topUp(mine, "intent-1", 25);

    const invoices = await adapter.listInvoices?.({ customer: mine });

    expect(invoices).toHaveLength(1);
    expect(invoices?.[0]).toMatchObject({
      amount: 2500,
      currency: "usd",
      status: "paid",
      number: expect.stringMatching(/^FAKE-/),
      viewUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/i\//),
      downloadUrl: expect.stringMatching(/\/pdf$/),
    });
    expect(Number.isNaN(Date.parse(invoices?.[0]?.createdAt ?? ""))).toBe(
      false,
    );
  });

  // #659-T02
  it("asks Stripe for no invoice on the checkout: invoice_creation is not a parameter of a top-up", async () => {
    const { fake, customer, topUp } = await start();
    await topUp(await customer("workspace-1"), "intent-1", 10);

    const sessions = fake
      .requests()
      .filter((r) => r.method === "POST" && r.path === "/v1/checkout/sessions");
    expect(sessions).toHaveLength(1);
    expect(Object.keys(sessions[0]?.form ?? {}).sort()).toEqual(
      [...STRIPE_CHECKOUT_PARAMETERS].sort(),
    );
    expect(sessions[0]?.form).not.toHaveProperty("invoice_creation");
  });

  // #659-T03
  it("never lists the invoices of another customer", async () => {
    const { fake, adapter, customer, topUp } = await start();
    const mine = await customer("workspace-1");
    const other = await customer("workspace-2");
    await topUp(other, "intent-other", 50);
    await topUp(mine, "intent-mine", 10);

    const invoices = await adapter.listInvoices?.({ customer: mine });

    expect(invoices?.map((invoice) => invoice.amount)).toEqual([1000]);
    const asked = fake
      .requests()
      .filter((r) => r.path === "/v1/invoices")
      .map((r) => r.query);
    expect(asked).toEqual([expect.objectContaining({ customer: mine })]);
  });

  // #659-T04
  it("lists nothing for a customer without invoices", async () => {
    const { adapter, customer } = await start();

    expect(
      await adapter.listInvoices?.({ customer: await customer("workspace-1") }),
    ).toEqual([]);
  });

  // #659-T01
  it("lists the newest first, leaves drafts out and keeps open, void and uncollectible ones", async () => {
    const { fake, adapter, customer } = await start();
    const mine = await customer("workspace-1");
    for (const [status, total] of [
      ["draft", 100],
      ["void", 200],
      ["open", 300],
      ["uncollectible", 400],
      ["paid", 500],
    ] as const)
      fake.stripe.addInvoice({ customer: mine, status, total });

    const invoices = await adapter.listInvoices?.({ customer: mine });

    expect(
      invoices?.map((invoice) => [invoice.status, invoice.amount]),
    ).toEqual([
      ["paid", 500],
      ["uncollectible", 400],
      ["open", 300],
      ["void", 200],
    ]);
  });

  // #659-T01
  it("drops an address that is not a web address, and an invoice of no value", async () => {
    const { fake, adapter, customer } = await start();
    const mine = await customer("workspace-1");
    fake.stripe.addInvoice({
      customer: mine,
      total: 700,
      hosted_invoice_url: "javascript:alert(1)",
      invoice_pdf: "https://pay.example.com/invoice/x/pdf",
    });
    fake.stripe.addInvoice({ customer: mine, total: 0 });

    const invoices = await adapter.listInvoices?.({ customer: mine });

    expect(invoices).toHaveLength(1);
    expect(invoices?.[0]).toMatchObject({
      viewUrl: null,
      downloadUrl: "https://pay.example.com/invoice/x/pdf",
    });
  });

  // #659-T01
  it("answers provider_unavailable when Stripe fails, without a word of what it said", async () => {
    const { fake, adapter, customer } = await start();
    const mine = await customer("workspace-1");
    fake.faults.failWith({ method: "GET", path: "/v1/invoices" }, 500, {
      times: 10,
    });

    const failure = await adapter
      .listInvoices?.({ customer: mine })
      .catch((e) => e);

    expect(failure).toBeInstanceOf(BillingAdapterError);
    expect((failure as BillingAdapterError).code).toBe("provider_unavailable");
  });
});
