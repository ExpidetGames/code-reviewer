// SPDX-License-Identifier: LicenseRef-Proprietary

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
  // The fake's links are http on loopback: only the adapter of a test gets that one origin allowed (`allowedLinkOrigin`).
  const adapter = createStripeAdapter({
    client: () => Promise.resolve(clientFor(fake)),
    allowedLinkOrigin: fake.baseUrl,
  });
  /** The adapter as production wires it: Stripe's own hosts only. */
  const productionAdapter = createStripeAdapter({
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
  return { fake, adapter, productionAdapter, customer, topUp };
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
  it("drops an invoice of no value", async () => {
    const { fake, adapter, customer } = await start();
    const mine = await customer("workspace-1");
    fake.stripe.addInvoice({ customer: mine, total: 700 });
    fake.stripe.addInvoice({ customer: mine, total: 0 });

    const invoices = await adapter.listInvoices?.({ customer: mine });

    expect(invoices?.map((invoice) => invoice.amount)).toEqual([700]);
  });

  // #659-T05
  describe("the addresses of an invoice", () => {
    const linksOf = async (viewUrl: string, downloadUrl: string) => {
      const { fake, productionAdapter, customer } = await start();
      const mine = await customer("workspace-1");
      fake.stripe.addInvoice({
        customer: mine,
        total: 700,
        hosted_invoice_url: viewUrl,
        invoice_pdf: downloadUrl,
      });
      const invoices = await productionAdapter.listInvoices?.({
        customer: mine,
      });
      return invoices?.[0];
    };

    it("keeps an https address on a Stripe host, a subdomain of stripe.com or stripe.com itself", async () => {
      const invoice = await linksOf(
        "https://invoice.stripe.com/i/acct_1/live_abc?s=ap",
        "https://pay.stripe.com/invoice/acct_1/live_abc/pdf",
      );

      expect(invoice).toMatchObject({
        viewUrl: "https://invoice.stripe.com/i/acct_1/live_abc?s=ap",
        downloadUrl: "https://pay.stripe.com/invoice/acct_1/live_abc/pdf",
      });
      expect(
        (await linksOf("https://stripe.com/i/x", "https://stripe.com/p/x"))
          ?.viewUrl,
      ).toBe("https://stripe.com/i/x");
    });

    it("drops http, even on a Stripe host", async () => {
      const invoice = await linksOf(
        "http://invoice.stripe.com/i/x",
        "http://pay.stripe.com/invoice/x/pdf",
      );

      expect(invoice).toMatchObject({ viewUrl: null, downloadUrl: null });
    });

    it("drops the fake's loopback address when the adapter has no test allowance", async () => {
      const { fake, productionAdapter, customer, topUp } = await start();
      const mine = await customer("workspace-1");
      await topUp(mine, "intent-1", 10);
      expect(fake.invoices()[0]?.hosted_invoice_url).toMatch(/^http:\/\/127/);

      const invoices = await productionAdapter.listInvoices?.({
        customer: mine,
      });

      expect(invoices).toHaveLength(1);
      expect(invoices?.[0]).toMatchObject({ viewUrl: null, downloadUrl: null });
    });

    it("drops a host that is not Stripe's, however it is spelled", async () => {
      for (const foreign of [
        "https://pay.example.com/invoice/x/pdf",
        "https://stripe.com.evil.example/i/x",
        "https://notstripe.com/i/x",
        "https://evilstripe.com/i/x",
        "https://stripe.com@evil.example/i/x",
        "https://user:secret@invoice.stripe.com/i/x",
        "https://127.0.0.1/i/x",
      ]) {
        const invoice = await linksOf(foreign, foreign);
        expect(invoice, foreign).toMatchObject({
          viewUrl: null,
          downloadUrl: null,
        });
      }
    });

    it("drops a script, a data address and text that is no address", async () => {
      for (const odd of [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "not an address",
        "",
      ]) {
        const invoice = await linksOf(odd, odd);
        expect(invoice, odd).toMatchObject({
          viewUrl: null,
          downloadUrl: null,
        });
      }
    });
  });

  // #659-T03
  it("drops an invoice of another customer even when Stripe forgets the customer filter", async () => {
    const { fake, adapter, customer, topUp } = await start();
    const mine = await customer("workspace-1");
    const other = await customer("workspace-2");
    await topUp(other, "intent-other", 50);
    await topUp(mine, "intent-mine", 10);
    fake.stripe.ignoreInvoiceCustomerFilter();

    const invoices = await adapter.listInvoices?.({ customer: mine });

    // The fake did answer both invoices: only the adapter's own check keeps the other one out.
    expect(
      fake.requests().filter((r) => r.path === "/v1/invoices"),
    ).toHaveLength(1);
    expect(invoices?.map((invoice) => invoice.amount)).toEqual([1000]);
  });

  // #659-T04
  it("answers customer_missing when Stripe has no such customer (a customer of the other environment)", async () => {
    const { adapter } = await start();

    const failure = await adapter
      .listInvoices?.({ customer: "cus_madeUnderAnotherKey" })
      .catch((e) => e);

    expect(failure).toBeInstanceOf(BillingAdapterError);
    expect((failure as BillingAdapterError).code).toBe("customer_missing");
  });

  // #659-T04
  it("keeps every other refusal of Stripe an error", async () => {
    const { fake, adapter, customer } = await start();
    const mine = await customer("workspace-1");
    fake.faults.failWith({ method: "GET", path: "/v1/invoices" }, 400, {
      body: {
        error: {
          type: "invalid_request_error",
          code: "parameter_invalid_empty",
          message: "Invalid customer",
        },
      },
    });
    fake.faults.failWith({ method: "GET", path: "/v1/invoices" }, 403);

    const rejected = await adapter
      .listInvoices?.({ customer: mine })
      .catch((e) => e);
    const forbidden = await adapter
      .listInvoices?.({ customer: mine })
      .catch((e) => e);

    expect((rejected as BillingAdapterError).code).toBe("provider_rejected");
    expect((forbidden as BillingAdapterError).code).toBe(
      "provider_not_configured",
    );
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
