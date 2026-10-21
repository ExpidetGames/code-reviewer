// SPDX-License-Identifier: Apache-2.0

// #501: starting a top-up: the checks in their order, the intent that is written first, the customer made from the profile
// and the Checkout Session, over a real database and the fake Stripe.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";
import { insertUser } from "../test-support/users.ts";
import { manualAdapter } from "./manual-adapter.ts";
import { BILLING_TERMS_VERSION, type BillingProfileInput } from "./profile.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import {
  TOP_UP_ERROR_CODES,
  createTopUpService,
  type TopUpResult,
} from "./topup-service.ts";

const INTENT_A = "6f1f4a2e-0c52-4b8e-9a43-0d0f6f1d2a11";
const INTENT_B = "0b6d7c1e-5d3a-4c0e-8f64-3a1f9e2b7c22";

const PROFILE: BillingProfileInput = {
  legalName: "Example GmbH",
  country: "DE",
  addressLine1: "Teststrasse 1",
  addressLine2: "c/o Example",
  postalCode: "10115",
  city: "Berlin",
  vatId: "DE123456789",
};
const PRIVATE_STRINGS = ["Example GmbH", "Teststrasse", "DE123456789", "10115"];

const RETURN_URL = "https://app.example.test/w/billing-a/billing";

async function allRows(db: Kysely<Database>): Promise<Record<string, string>> {
  const tables = await sql<{ name: string }>`
    select table_name as name from information_schema.tables where table_schema = 'public'`
    .execute(db)
    .then((result) => result.rows)
    .catch(
      async () =>
        (
          await sql<{
            name: string;
          }>`select name from sqlite_master where type = 'table'`.execute(db)
        ).rows,
    );
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const rows = await sql
      .raw(`select * from "${name}"`)
      .execute(db)
      .then((result) => result.rows);
    out[name] = JSON.stringify(rows);
  }
  return out;
}

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(`starting a top-up on ${engine.name}`, () => {
    async function start() {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      await insertUser(db, { id: "owner" });
      const fake = await startTestStripe();
      const adapter = createStripeAdapter({
        client: () => Promise.resolve(clientFor(fake)),
      });
      const logs: string[] = [];
      const service = createTopUpService({
        db,
        adapter,
        log: (line) => logs.push(line),
      });
      const profiles = createBillingProfilesRepository(db, workspaceId);
      const intents = createBillingTopUpIntentsRepository(db, workspaceId);
      const actor = (role: "owner" | "admin" | "member" = "owner") => ({
        workspaceId,
        userId: "owner",
        role,
      });
      const top = (
        body: Record<string, unknown> = {},
        role: "owner" | "admin" | "member" = "owner",
      ): Promise<TopUpResult> =>
        service.start(actor(role), {
          amountCents: 2500,
          confirmBusiness: true,
          intentId: undefined,
          ...body,
          returnUrl: RETURN_URL,
        });
      return {
        db,
        workspaceId,
        otherWorkspaceId,
        fake,
        adapter,
        service,
        logs,
        profiles,
        intents,
        actor,
        top,
      };
    }
    const stripeCalls = (t: Awaited<ReturnType<typeof start>>) =>
      t.fake.requests().length;

    // #501-T01
    it("starts a first top-up of 25 USD: the customer, the session, a pending intent, the confirmation, and the page to go to", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      const result = await t.top();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [intent] = await t.intents.list({ limit: 10 });
      expect(intent).toMatchObject({
        id: result.intentId,
        adapter: "stripe",
        amountMicroUsd: 25_000_000,
        state: "pending",
        checkoutRef: t.fake.checkoutSessions()[0]?.id,
        paymentRef: null,
      });
      expect(t.fake.customers()).toHaveLength(1);
      expect(t.fake.customers()[0]).toMatchObject({
        name: "Example GmbH",
        preferred_locales: ["en"],
      });
      expect(
        t.fake
          .requests()
          .filter((r) => r.path.endsWith("/tax_ids") && r.method === "POST"),
      ).toHaveLength(1);
      expect(t.fake.checkoutSessions()).toHaveLength(1);
      expect(t.fake.checkoutSessions()[0]).toMatchObject({
        amount_total: 2500,
        customer: t.fake.customers()[0]?.id,
        client_reference_id: result.intentId,
        managed_payments: { enabled: true },
      });
      expect(result.url).toBe(t.fake.checkoutSessions()[0]?.url);
      expect(await t.profiles.get()).toMatchObject({
        confirmedBy: "owner",
        termsVersion: BILLING_TERMS_VERSION,
        customerAdapter: "stripe",
        customerRef: t.fake.customers()[0]?.id,
      });
      expect((await t.profiles.get())?.confirmedAt).not.toBeNull();
    });

    // #501-T01
    it("never credits: the balance is what it was", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      await t.top();

      const journal = createBillingJournalRepository(t.db, t.workspaceId);
      expect((await journal.balance()).balanceMicroUsd).toBe(0);
      expect((await journal.entries({ limit: 10 })).entries).toEqual([]);
    });

    // #501-T02
    it("refuses an amount that is not 10 to 500 USD in whole cents with a code, before Stripe is called and before an intent is written", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      const refusals: Array<[unknown, string]> = [
        [999, "amount_out_of_range"], // 9.99
        [50001, "amount_out_of_range"], // 500.01
        [0, "amount_out_of_range"],
        [-5, "amount_out_of_range"],
        [1000.5, "amount_invalid"], // half a cent
        [25.5, "amount_invalid"],
        ["2500", "amount_invalid"],
        [undefined, "amount_invalid"],
        [null, "amount_invalid"],
        [true, "amount_invalid"],
        [[2500], "amount_invalid"],
        [{ cents: 2500 }, "amount_invalid"],
        [Number.MAX_SAFE_INTEGER + 1, "amount_invalid"],
        [Infinity, "amount_invalid"],
        [Number.NaN, "amount_invalid"],
      ];
      for (const [amountCents, error] of refusals)
        expect(await t.top({ amountCents }), String(amountCents)).toEqual({
          ok: false,
          error,
        });
      expect(stripeCalls(t)).toBe(0);
      expect(await t.intents.list({ limit: 10 })).toEqual([]);
      expect(await t.profiles.get()).toMatchObject({ confirmedAt: null });
    });

    // #501-T02
    it("accepts the edges of the range: 10 and 500 USD", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      expect(await t.top({ amountCents: 1000 })).toMatchObject({ ok: true });
      expect(await t.top({ amountCents: 50000 })).toMatchObject({ ok: true });

      expect(
        (await t.intents.list({ limit: 10 })).map((i) => i.amountMicroUsd),
      ).toEqual([500_000_000, 10_000_000]);
    });

    // #501-T03
    it("needs the billing profile first", async () => {
      const t = await start();

      expect(await t.top()).toEqual({ ok: false, error: "profile_required" });

      expect(stripeCalls(t)).toBe(0);
      expect(await t.intents.list({ limit: 10 })).toEqual([]);
    });

    // #501-T03
    it("needs the business confirmation at the first top-up, and only then", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      for (const confirmBusiness of [undefined, false, "true", 1, null])
        expect(
          await t.top({ confirmBusiness }),
          String(confirmBusiness),
        ).toEqual({ ok: false, error: "business_confirmation_required" });
      expect(stripeCalls(t)).toBe(0);
      expect(await t.intents.list({ limit: 10 })).toEqual([]);
      expect(await t.profiles.get()).toMatchObject({ confirmedAt: null });

      expect(await t.top()).toMatchObject({ ok: true });
      // Given once: the next top-up does not ask again.
      expect(await t.top({ confirmBusiness: undefined })).toMatchObject({
        ok: true,
      });
      expect(await t.intents.list({ limit: 10 })).toHaveLength(2);
    });

    // #501-T03
    it("checks the profile before the confirmation, so a person with neither is told to make the profile", async () => {
      const t = await start();

      expect(await t.top({ confirmBusiness: false })).toEqual({
        ok: false,
        error: "profile_required",
      });
    });

    // #501-T04
    it("refuses a Member and stores nothing", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      expect(await t.top({}, "member")).toEqual({
        ok: false,
        error: "forbidden",
      });

      expect(stripeCalls(t)).toBe(0);
      expect(await t.intents.list({ limit: 10 })).toEqual([]);
      expect(await t.profiles.get()).toMatchObject({ confirmedAt: null });
    });

    // #501-T04
    it("lets an Admin top up as well as an Owner", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      expect(await t.top({}, "admin")).toMatchObject({ ok: true });
    });

    // #501-T06
    it("starts the same intent twice as one session: the retry returns the same page", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      const first = await t.top({ intentId: INTENT_A });
      const second = await t.top({ intentId: INTENT_A });

      expect(first).toMatchObject({ ok: true, intentId: INTENT_A });
      expect(second).toEqual(first);
      expect(t.fake.checkoutSessions()).toHaveLength(1);
      expect(await t.intents.list({ limit: 10 })).toHaveLength(1);
      expect(t.fake.customers()).toHaveLength(1);
    });

    // #501-T06
    it("gets the page back after the first answer of Stripe was lost", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      t.fake.faults.dropResponse(
        { method: "POST", path: "/v1/checkout/sessions" },
        { mode: "reset" },
      );

      const result = await t.top({ intentId: INTENT_A });

      expect(result).toMatchObject({ ok: true, intentId: INTENT_A });
      expect(t.fake.checkoutSessions()).toHaveLength(1);
    });

    // #501-T06
    it("starts two clicks at once as one session", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);

      const [one, two] = await Promise.all([
        t.top({ intentId: INTENT_A }),
        t.top({ intentId: INTENT_A }),
      ]);

      expect(one).toMatchObject({ ok: true });
      expect(two).toEqual(one);
      expect(t.fake.checkoutSessions()).toHaveLength(1);
      expect(await t.intents.list({ limit: 10 })).toHaveLength(1);
    });

    // #501-T06
    it("refuses an intent id that is not an id, and one that is used for another amount, a paid one, or one of another workspace", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      expect(await t.top({ intentId: "x" })).toEqual({
        ok: false,
        error: "intent_id_invalid",
      });
      expect(await t.top({ intentId: 5 })).toEqual({
        ok: false,
        error: "intent_id_invalid",
      });
      await t.top({ intentId: INTENT_A });

      expect(await t.top({ intentId: INTENT_A, amountCents: 3000 })).toEqual({
        ok: false,
        error: "intent_conflict",
      });
      const intent = (await t.intents.get(INTENT_A))!;
      await t.intents.markPaid(INTENT_A, {
        paymentRef: "pi_1",
        creditedMicroUsd: intent.amountMicroUsd,
      });
      expect(await t.top({ intentId: INTENT_A })).toEqual({
        ok: false,
        error: "intent_conflict",
      });
      await createBillingTopUpIntentsRepository(
        t.db,
        t.otherWorkspaceId,
      ).create({ id: INTENT_B, adapter: "stripe", amountMicroUsd: 25_000_000 });
      expect(await t.top({ intentId: INTENT_B })).toEqual({
        ok: false,
        error: "intent_conflict",
      });
      expect(t.fake.checkoutSessions()).toHaveLength(1);
    });

    // #501-T07
    it("leaves no pending intent behind when Stripe fails, answers a code, and keeps the balance", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      t.fake.faults.failWith(
        { method: "POST", path: "/v1/checkout/sessions" },
        503,
        { times: 10 },
      );

      const result = await t.top({ intentId: INTENT_A });

      expect(result).toEqual({ ok: false, error: "provider_unavailable" });
      expect(await t.intents.list({ limit: 10 })).toMatchObject([
        { id: INTENT_A, state: "failed" },
      ]);
      expect(t.fake.checkoutSessions()).toHaveLength(0);
      const journal = createBillingJournalRepository(t.db, t.workspaceId);
      expect((await journal.balance()).balanceMicroUsd).toBe(0);
    });

    // #501-T07
    it("answers provider_unavailable for a customer that cannot be made, and a rate limit", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      t.fake.faults.failWith({ method: "POST", path: "/v1/customers" }, 500, {
        times: 10,
      });
      expect(await t.top()).toEqual({
        ok: false,
        error: "provider_unavailable",
      });
      t.fake.faults.clear();
      t.fake.faults.rateLimit(
        { method: "POST", path: "/v1/checkout/sessions" },
        { retryAfterSeconds: 3600, times: 10 },
      );
      expect(await t.top()).toEqual({
        ok: false,
        error: "provider_unavailable",
      });
      expect(
        (await t.intents.list({ limit: 10 })).every(
          (i) => i.state === "failed",
        ),
      ).toBe(true);
    });

    // #501-T07
    it("can be tried again after a failure, with a new intent, and then works", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      t.fake.faults.failWith(
        { method: "POST", path: "/v1/checkout/sessions" },
        503,
        { times: 10 },
      );
      expect(await t.top({ intentId: INTENT_A })).toMatchObject({ ok: false });
      t.fake.faults.clear();

      expect(await t.top({ intentId: INTENT_B })).toMatchObject({ ok: true });

      expect(
        (await t.intents.list({ limit: 10 })).map((i) => i.state).sort(),
      ).toEqual(["failed", "pending"]);
    });

    // #501-T07
    it("answers vat_id_rejected when Stripe will not take the number, and writes no session", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      t.fake.faults.failWith({ method: "POST", path: /\/tax_ids$/ }, 400);

      expect(await t.top()).toEqual({ ok: false, error: "vat_id_rejected" });
      expect(t.fake.checkoutSessions()).toHaveLength(0);
    });

    // #501-T08
    it("updates the customer of a returning buyer and does not make a second one", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      await t.top();
      const [customer] = t.fake.customers();

      await t.profiles.save({ ...PROFILE, legalName: "Renamed GmbH" });
      await t.top();

      expect(t.fake.customers()).toHaveLength(1);
      expect(t.fake.customers()[0]).toMatchObject({
        id: customer?.id,
        name: "Renamed GmbH",
      });
      expect(t.fake.checkoutSessions()).toHaveLength(2);
      expect(
        t.fake.checkoutSessions().every((s) => s.customer === customer?.id),
      ).toBe(true);
    });

    // #501-T08
    it("makes the customer again when the stored one is of another adapter", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      await t.profiles.setCustomer("other", "cus_elsewhere");

      await t.top();

      const requests = t.fake.requests().map((r) => `${r.method} ${r.path}`);
      expect(requests).not.toContain("POST /v1/customers/cus_elsewhere");
      expect(t.fake.customers()).toHaveLength(1);
      expect(await t.profiles.get()).toMatchObject({
        customerAdapter: "stripe",
      });
    });

    // #501-T10
    it("says checkout_unavailable for an adapter with no checkout, before it writes an intent", async () => {
      const t = await start();
      await t.profiles.save(PROFILE);
      const service = createTopUpService({ db: t.db, adapter: manualAdapter });

      expect(
        await service.start(t.actor(), {
          amountCents: 2500,
          confirmBusiness: true,
          intentId: undefined,
          returnUrl: RETURN_URL,
        }),
      ).toEqual({ ok: false, error: "checkout_unavailable" });
      expect(await t.intents.list({ limit: 10 })).toEqual([]);
    });

    // #501-T09
    it("logs a result code and nothing of the profile, the amount or the page, and keeps the profile in its table", async () => {
      const t = await start();
      const output: string[] = [];
      const capture = (...parts: unknown[]) =>
        void output.push(parts.join(" "));
      const { log, info, warn, error } = console;
      console.log = console.info = console.warn = console.error = capture;
      try {
        await t.profiles.save(PROFILE);
        await t.top({ amountCents: 4321 });
        t.fake.faults.failWith(
          { method: "POST", path: "/v1/checkout/sessions" },
          503,
          { times: 10 },
        );
        await t.top({ amountCents: 4321 });
        await t.top({ amountCents: 9 });
      } finally {
        Object.assign(console, { log, info, warn, error });
      }

      const lines = [...t.logs, ...output].join("\n");
      expect(t.logs.length).toBeGreaterThan(0);
      for (const text of [
        ...PRIVATE_STRINGS,
        "4321",
        "43.21",
        "checkout.example",
        "cs_",
        "cus_",
      ])
        expect(lines, text).not.toContain(text);
      const rows = await allRows(t.db);
      for (const [table, json] of Object.entries(rows))
        for (const text of PRIVATE_STRINGS)
          if (table !== "billing_profiles")
            expect(json, `${table} holds ${text}`).not.toContain(text);
      expect(rows["billing_profiles"]).toContain("Teststrasse");
    });

    it("has stable codes", () => {
      expect(new Set(TOP_UP_ERROR_CODES).size).toBe(TOP_UP_ERROR_CODES.length);
      for (const code of TOP_UP_ERROR_CODES)
        expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
