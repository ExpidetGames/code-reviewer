// SPDX-License-Identifier: Apache-2.0

// #501: the Stripe adapter against the fake Stripe (fakes/stripe), which refuses what Managed Payments refuses.
import { describe, expect, it } from "vitest";
import { BillingAdapterError, toUsd, type BillingProfile } from "./adapter.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";

const USD = 1_000_000;
const WORKSPACE = { id: "workspace-1" };

const PROFILE: BillingProfile = {
  legalName: "Example GmbH",
  country: "DE",
  addressLines: ["Teststrasse 1", "c/o Example"],
  postalCode: "10115",
  city: "Berlin",
  vatId: "DE123456789",
  locale: "en",
};

async function start() {
  const fake = await startTestStripe();
  const adapter = createStripeAdapter({
    client: () => Promise.resolve(clientFor(fake)),
  });
  return { fake, adapter };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof BillingAdapterError ? error.code : "other";
  }
  return "none";
}

const taxIdsOf = (fake: Awaited<ReturnType<typeof start>>["fake"]) =>
  fake
    .requests()
    .filter((r) => r.method === "POST" && r.path.endsWith("/tax_ids"))
    .map((r) => r.form);

describe("the customer made from the billing profile", () => {
  // #501-T01
  it("creates the customer once from the profile, with the business name, the address, the locale and the VAT ID", async () => {
    const { fake, adapter } = await start();

    const id = await adapter.ensureCustomer({
      workspace: WORKSPACE,
      profile: PROFILE,
      customer: null,
    });

    expect(fake.customers()).toHaveLength(1);
    expect(id).toBe(fake.customers()[0]?.id);
    expect(fake.customers()[0]).toMatchObject({
      name: "Example GmbH",
      business_name: "Example GmbH",
      address: {
        line1: "Teststrasse 1",
        line2: "c/o Example",
        city: "Berlin",
        postal_code: "10115",
        country: "DE",
      },
      preferred_locales: ["en"],
      metadata: { workspace: "workspace-1" },
    });
    expect(taxIdsOf(fake)).toEqual([{ type: "eu_vat", value: "DE123456789" }]);
  });

  // #501-T06
  it("makes the customer once when the same profile is asked for twice before the id is stored", async () => {
    const { fake, adapter } = await start();
    const ask = () =>
      adapter.ensureCustomer({
        workspace: WORKSPACE,
        profile: PROFILE,
        customer: null,
      });

    const [first, second] = await Promise.all([ask(), ask()]);
    const third = await ask();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(fake.customers()).toHaveLength(1);
  });

  // #501-T08
  it("updates the customer it already has, and does not make another", async () => {
    const { fake, adapter } = await start();
    const id = await adapter.ensureCustomer({
      workspace: WORKSPACE,
      profile: PROFILE,
      customer: null,
    });

    const again = await adapter.ensureCustomer({
      workspace: WORKSPACE,
      profile: {
        ...PROFILE,
        legalName: "Renamed GmbH",
        addressLines: ["Neue Strasse 2"],
        city: "Hamburg",
      },
      customer: id,
    });

    expect(again).toBe(id);
    expect(fake.customers()).toHaveLength(1);
    expect(fake.customers()[0]).toMatchObject({
      name: "Renamed GmbH",
      business_name: "Renamed GmbH",
      address: { line1: "Neue Strasse 2", line2: null, city: "Hamburg" },
    });
  });

  // #501-T08
  it("keeps the VAT ID of the customer equal to the profile's: a changed one replaces it, none removes it, the same one stays", async () => {
    const { fake, adapter } = await start();
    const ask = (vatId: string | null, customer: string | null) =>
      adapter.ensureCustomer({
        workspace: WORKSPACE,
        profile: { ...PROFILE, vatId },
        customer,
      });
    const id = (await ask("DE123456789", null)) as string;
    const idsNow = async () =>
      (
        await clientFor(fake).getCustomer(id, { expandTaxIds: true })
      ).tax_ids?.data.map((t) => `${t.type}:${t.value}`);

    await ask("DE123456789", id);
    expect(await idsNow()).toEqual(["eu_vat:DE123456789"]);
    expect(taxIdsOf(fake)).toHaveLength(1);

    await ask("DE987654321", id);
    expect(await idsNow()).toEqual(["eu_vat:DE987654321"]);

    await ask(null, id);
    expect(await idsNow()).toEqual([]);
    expect(fake.customers()).toHaveLength(1);
  });

  // #501-T01
  it("picks the Stripe tax id type of the country, and sends a Norwegian number without its country prefix", async () => {
    const { fake, adapter } = await start();
    for (const [country, vatId] of [
      ["DE", "DE123456789"],
      ["GR", "EL123456789"],
      ["GB", "GB123456789"],
      ["CH", "CHE123456789MWST"],
      ["NO", "NO123456789MVA"],
    ] as const)
      await adapter.ensureCustomer({
        workspace: { id: `w-${country}` },
        profile: { ...PROFILE, country, vatId },
        customer: null,
      });

    expect(taxIdsOf(fake)).toEqual([
      { type: "eu_vat", value: "DE123456789" },
      { type: "eu_vat", value: "EL123456789" },
      { type: "gb_vat", value: "GB123456789" },
      { type: "ch_vat", value: "CHE123456789MWST" },
      { type: "no_vat", value: "123456789MVA" },
    ]);
  });

  // #501-T08
  it("makes the customer again when Stripe no longer knows the stored one", async () => {
    const { fake, adapter } = await start();
    const id = await adapter.ensureCustomer({
      workspace: WORKSPACE,
      profile: PROFILE,
      customer: null,
    });
    fake.deleteCustomer(id as string);

    const next = await adapter.ensureCustomer({
      workspace: WORKSPACE,
      profile: { ...PROFILE, legalName: "Example AG" },
      customer: id,
    });

    expect(next).not.toBe(id);
    expect(fake.customers().map((c) => c.id)).toEqual([next]);
  });

  // #501-T12
  it("says vat_id_rejected, and nothing else, when Stripe does not take the number", async () => {
    const { fake, adapter } = await start();
    fake.faults.failWith({ method: "POST", path: /\/tax_ids$/ }, 400, {
      body: {
        error: {
          type: "invalid_request_error",
          message: "Invalid value for eu_vat.",
        },
      },
    });

    expect(
      await codeOf(
        adapter.ensureCustomer({
          workspace: WORKSPACE,
          profile: PROFILE,
          customer: null,
        }),
      ),
    ).toBe("vat_id_rejected");
  });

  // #501-T09
  it("sends the profile to Stripe and nowhere else", async () => {
    const { fake, adapter } = await start();
    const output: string[] = [];
    const spy = (...parts: unknown[]) => void output.push(parts.join(" "));
    const { log, info, warn, error } = console;
    console.log = console.info = console.warn = console.error = spy;
    try {
      await adapter.ensureCustomer({
        workspace: WORKSPACE,
        profile: PROFILE,
        customer: null,
      });
    } finally {
      Object.assign(console, { log, info, warn, error });
    }

    expect(output).toEqual([]);
    expect(fake.requests().every((r) => r.authenticated)).toBe(true);
  });
});

describe("the top-up checkout", () => {
  const topUp = (customer: string, intentId = "intent-1", cents = 2500) => ({
    customer,
    intentId,
    amount: toUsd(cents * 10_000),
    returnUrl: "https://app.example.test/w/acme/billing",
  });

  async function withCustomer() {
    const { fake, adapter } = await start();
    const customer = (await adapter.ensureCustomer({
      workspace: WORKSPACE,
      profile: PROFILE,
      customer: null,
    })) as string;
    return { fake, adapter, customer };
  }

  // #501-T01
  it("makes a Managed Payments session of 25 USD for the customer, with our intent as the reference", async () => {
    const { fake, adapter, customer } = await withCustomer();

    const started = await adapter.createTopUpCheckout(topUp(customer));

    expect(fake.checkoutSessions()).toHaveLength(1);
    const [session] = fake.checkoutSessions();
    expect(session).toMatchObject({
      mode: "payment",
      status: "open",
      customer,
      client_reference_id: "intent-1",
      metadata: { intent: "intent-1" },
      amount_total: 2500,
      currency: "usd",
      managed_payments: { enabled: true },
    });
    expect(started).toEqual({
      checkout: { kind: "redirect", url: session?.url },
      session: session?.id,
      payment: null,
    });
    const sent = fake
      .requests()
      .find((r) => r.path === "/v1/checkout/sessions");
    expect(sent?.form).toMatchObject({
      line_items: [
        {
          quantity: "1",
          price_data: {
            currency: "usd",
            unit_amount: "2500",
            tax_behavior: "exclusive",
            product_data: {
              name: "Review credit",
              tax_code: "txcd_10105002",
            },
          },
        },
      ],
    });
  });

  // #501-T06
  it("answers the same intent with the same session, also when the first answer was lost", async () => {
    const { fake, adapter, customer } = await withCustomer();
    // The request runs at Stripe, the answer never arrives: the client tries again with the same key.
    fake.faults.dropResponse(
      { method: "POST", path: "/v1/checkout/sessions" },
      { mode: "reset" },
    );

    const first = await adapter.createTopUpCheckout(topUp(customer));
    const second = await adapter.createTopUpCheckout(topUp(customer));

    expect(fake.checkoutSessions()).toHaveLength(1);
    expect(second).toEqual(first);
    const other = await adapter.createTopUpCheckout(
      topUp(customer, "intent-2"),
    );
    expect(other.session).not.toBe(first.session);
    expect(fake.checkoutSessions()).toHaveLength(2);
  });

  // #501-T07
  it("is provider_unavailable when Stripe keeps failing, and no session exists", async () => {
    const { fake, adapter, customer } = await withCustomer();
    fake.faults.failWith(
      { method: "POST", path: "/v1/checkout/sessions" },
      503,
      { times: 10 },
    );

    expect(await codeOf(adapter.createTopUpCheckout(topUp(customer)))).toBe(
      "provider_unavailable",
    );
    expect(fake.checkoutSessions()).toHaveLength(0);
  });

  // #501-T05
  it("is accepted by Managed Payments for every amount of the range, down to 10 and up to 500 USD", async () => {
    const { fake, adapter, customer } = await withCustomer();

    for (const cents of [1000, 1001, 50000])
      await adapter.createTopUpCheckout(
        topUp(customer, `intent-${cents}`, cents),
      );

    expect(fake.checkoutSessions().map((s) => s.amount_total)).toEqual([
      1000, 1001, 50000,
    ]);
  });

  // #501-T02
  it("holds the floor itself: the fake takes one cent, the adapter does not send it", async () => {
    const { fake, adapter, customer } = await withCustomer();

    expect(
      await codeOf(
        adapter.createTopUpCheckout({
          ...topUp(customer),
          amount: 10_000 as never,
        }),
      ),
    ).toBe("amount_out_of_range");
    expect(
      fake.requests().filter((r) => r.path === "/v1/checkout/sessions"),
    ).toHaveLength(0);
    // Positive control: the fake itself accepts that amount (so a test of the floor cannot lean on it).
    const direct = await clientFor(fake).createCheckoutSession(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: 1,
              product_data: { name: "x", tax_code: "txcd_10105002" },
            },
          },
        ],
        success_url: "https://app.example.test/s",
        cancel_url: "https://app.example.test/c",
        managed_payments: { enabled: true },
      },
      { idempotencyKey: "direct" },
    );
    expect(direct.amount_total).toBe(1);
  });
});
