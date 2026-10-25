// SPDX-License-Identifier: LicenseRef-Proprietary

// #502: `POST /api/w/:workspace/billing/top-ups/:id/check` ("Check payment") as the app wires it (guard, adapter, access,
// limit, service), over a real database, the real matrix of roles and the fake Stripe: it repairs a lost webhook by asking
// Stripe for the Checkout Session and applying the same normalized event the webhook would have, once.
import { describe, expect, it } from "vitest";
import { signStripeWebhook } from "../../../fakes/stripe/server.ts";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { signedInMember } from "../test-support/session-lookup.ts";
import { clientFor, startTestStripe } from "../test-support/stripe-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { resolveWorkspaceAccess } from "../workspaces/access.ts";
import { accessRefusal } from "../workspaces/access-response.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import type { BillingAdapter } from "./adapter.ts";
import { applyBillingEvent } from "./apply-event.ts";
import { isBillingOn } from "./enabled.ts";
import { manualAdapter } from "./manual-adapter.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import type { CreateCheckoutSessionInput } from "./stripe-client.ts";
import { createTopUpCheckRoute } from "./topup-check-http.ts";
import { createTopUpCheckService } from "./topup-check.ts";
import {
  CHECK_PAYMENT_REQUESTS_MAX,
  createCheckPaymentLimits,
  type TopUpLimits,
} from "./topup-limits.ts";

const SECRET = "whsec_CheckPaymentTestSecret000000";
const SESSION_INPUT: CreateCheckoutSessionInput = {
  mode: "payment",
  line_items: [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: 2500,
        tax_behavior: "exclusive",
        product_data: { name: "Review credit", tax_code: "txcd_10105002" },
      },
    },
  ],
  success_url: "https://app.example.test/billing?topup=success",
  cancel_url: "https://app.example.test/billing?topup=cancelled",
  managed_payments: { enabled: true },
};

class NotFound extends Error {}

async function start(
  options: {
    billingOn?: boolean;
    adapter?: "stripe" | "manual";
    limits?: TopUpLimits;
  } = {},
) {
  const { db } = await createTestDatabase();
  const workspaceId = await addWorkspace(db, "acme");
  const otherWorkspaceId = await addWorkspace(db, "other");
  await setBillingSwitch(db, options.billingOn ?? true);
  const fake = await startTestStripe();
  const client = clientFor(fake);
  const stripe = createStripeAdapter({
    client: () => Promise.resolve(client),
    webhookSecret: () => Promise.resolve(SECRET),
    environment: () => Promise.resolve("test"),
  });
  const adapter: BillingAdapter =
    options.adapter === "manual" ? manualAdapter : stripe;
  const logs: string[] = [];
  const route = createTopUpCheckRoute({
    guard: {
      isOn: () => isBillingOn(db),
      notFound: () => {
        throw new NotFound("not found");
      },
    },
    activeAdapter: () => Promise.resolve(adapter),
    serviceFor: (active) =>
      createTopUpCheckService({
        db,
        adapter: active,
        log: (l) => logs.push(l),
      }),
    limits:
      options.limits ??
      createCheckPaymentLimits(createRateLimitsRepository(db)),
    log: { info: (line) => logs.push(line) },
  });
  const workspaces = createWorkspacesRepository(db);
  const as =
    (lookup: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" }) =>
    (handler: Parameters<Parameters<typeof route.post>[3]>[0]) =>
      resolveWorkspaceAccess({
        lookup,
        slug: "acme",
        action: "manage_billing",
        findMembership: (userId, name) =>
          workspaces.findMembership(userId, name),
      }).then((result) =>
        result.kind === "ok" ? handler(result.access) : accessRefusal(result),
      );
  const person = (
    role: WorkspaceRole,
    workspace = workspaceId,
    id = `u-${role}`,
  ) => signedInMember(db, { id, workspaceId: workspace, role });
  const intents = createBillingTopUpIntentsRepository(db, workspaceId);
  let counter = 0;
  /** An intent with its Checkout Session at the fake, recorded the way the start of a top-up records it. */
  async function topUp(workspace = workspaceId) {
    counter += 1;
    const repository = createBillingTopUpIntentsRepository(db, workspace);
    const intent = await repository.create({
      adapter: "stripe",
      amountMicroUsd: 25_000_000,
    });
    const session = await client.createCheckoutSession(
      {
        ...SESSION_INPUT,
        client_reference_id: intent.id,
        metadata: { intent: intent.id },
      },
      { idempotencyKey: `check-${counter}` },
    );
    await repository.attachRefs(intent.id, { checkoutRef: session.id });
    return { intent, session };
  }
  const check = (
    id: string,
    who: Awaited<ReturnType<typeof signedInMember>> | { kind: "none" },
    headers: Record<string, string> = {},
  ) =>
    route.post(
      new Request(
        `https://app.example.test/api/w/acme/billing/top-ups/${id}/check`,
        { method: "POST", headers },
      ),
      "acme",
      id,
      as(who),
    );
  return {
    db,
    workspaceId,
    otherWorkspaceId,
    fake,
    client,
    stripe,
    route,
    logs,
    person,
    intents,
    topUp,
    check,
    journal: createBillingJournalRepository(db, workspaceId),
    requests: () => fake.requests().length,
  };
}

const credits = async (t: Awaited<ReturnType<typeof start>>) =>
  (await t.journal.entries({ limit: 50 })).entries.filter(
    (entry) => entry.type === "top_up",
  );

describe("Check payment", () => {
  // #502-T11
  it("applies the credit of a payment whose webhook was lost, once: a second click and a late webhook add nothing", async () => {
    const t = await start();
    const { intent, session } = await t.topUp();
    const paid = t.fake.buyer.pay(session.id, { taxAmount: 475 });
    const owner = await t.person("owner");

    const first = await t.check(intent.id, owner);
    const afterFirst = t.requests();
    const second = await t.check(intent.id, owner);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ intentId: intent.id, state: "paid" });
    expect(await second.json()).toEqual({ intentId: intent.id, state: "paid" });
    // A paid intent is not asked about again.
    expect(t.requests()).toBe(afterFirst);
    expect(await credits(t)).toMatchObject([
      { amountMicroUsd: 25_000_000, providerRef: paid.paymentIntent.id },
    ]);

    // The webhook that was thought lost arrives late.
    const completed = t.fake
      .events()
      .find((event) => event.type === "checkout.session.completed");
    const body = JSON.stringify(completed);
    const late = await t.stripe.verifyAndParseWebhook?.({
      headers: new Headers({
        "stripe-signature": signStripeWebhook(
          body,
          SECRET,
          Math.floor(Date.now() / 1000),
        ),
      }),
      rawBody: new TextEncoder().encode(body),
      now: new Date(),
    });
    if (late === undefined || !late.ok) throw new Error("not accepted");
    const applied = await applyBillingEvent(t.db, {
      provider: "stripe",
      event: late.event,
    });

    expect(applied.outcome).toBe("duplicate_ignored");
    expect(await credits(t)).toHaveLength(1);
    expect((await t.journal.balance()).balanceMicroUsd).toBe(25_000_000);
  });

  // #502-T11
  it("changes nothing while the buyer is still on the page", async () => {
    const t = await start();
    const { intent } = await t.topUp();

    const response = await t.check(intent.id, await t.person("admin"));

    expect(await response.json()).toEqual({
      intentId: intent.id,
      state: "pending",
    });
    expect(await credits(t)).toEqual([]);
  });

  // #502-T03
  it("marks an intent failed when the delayed payment failed, and expired when the page expired", async () => {
    const t = await start();
    const failing = await t.topUp();
    t.fake.buyer.failAsync(failing.session.id);
    const expiring = await t.topUp();
    await t.client.expireCheckoutSession(expiring.session.id);
    const owner = await t.person("owner");

    const failed = await t.check(failing.intent.id, owner);
    const expired = await t.check(expiring.intent.id, owner);

    expect(await failed.json()).toMatchObject({ state: "failed" });
    expect(await expired.json()).toMatchObject({ state: "expired" });
    expect(await credits(t)).toEqual([]);
  });

  // #502-T03
  it("pays an intent that was marked failed when the session turns out to be paid", async () => {
    const t = await start();
    const { intent, session } = await t.topUp();
    await t.intents.markFailed(intent.id);
    t.fake.buyer.pay(session.id);

    const response = await t.check(intent.id, await t.person("owner"));

    expect(await response.json()).toMatchObject({ state: "paid" });
    expect(await credits(t)).toHaveLength(1);
  });

  // #502-T12
  it("takes a session that is gone at Stripe as nothing to report: no error, the journal intact", async () => {
    const t = await start();
    const { intent } = await t.topUp();
    t.fake.reset();

    const response = await t.check(intent.id, await t.person("owner"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      intentId: intent.id,
      state: "pending",
    });
    expect((await t.journal.verify()).consistent).toBe(true);
  });

  // #502-T11
  it("asks nobody for an intent that never got a page", async () => {
    const t = await start();
    const intent = await t.intents.create({
      adapter: "stripe",
      amountMicroUsd: 25_000_000,
    });

    const response = await t.check(intent.id, await t.person("owner"));

    expect(await response.json()).toMatchObject({ state: "pending" });
    expect(t.fake.requests()).toEqual([]);
  });

  // #502-T11
  it("answers a stable code and changes nothing when Stripe is down", async () => {
    const t = await start();
    const { intent, session } = await t.topUp();
    t.fake.buyer.pay(session.id);
    t.fake.faults.failWith({ method: "GET" }, 503, { times: 10 });

    const response = await t.check(intent.id, await t.person("owner"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provider_unavailable" });
    expect(await credits(t)).toEqual([]);
    expect(await t.intents.get(intent.id)).toMatchObject({ state: "pending" });
  });
});

describe("who may check", () => {
  // #502-T15
  it("refuses a Member, and asks nobody", async () => {
    const t = await start();
    const { intent, session } = await t.topUp();
    t.fake.buyer.pay(session.id);
    const sent = t.requests();

    const response = await t.check(intent.id, await t.person("member"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(t.requests()).toBe(sent);
    expect(await credits(t)).toEqual([]);
  });

  // #502-T15
  it("refuses a person of another workspace and a person not signed in, and credits nothing", async () => {
    const t = await start();
    const { intent, session } = await t.topUp();
    t.fake.buyer.pay(session.id);
    const outsider = await t.person("owner", t.otherWorkspaceId, "u-out");

    const outside = await t.check(intent.id, outsider);
    const anonymous = await t.check(intent.id, { kind: "none" });

    expect(outside.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(await credits(t)).toEqual([]);
  });

  // #502-T15
  it("does not find the intent of another workspace under this workspace's address", async () => {
    const t = await start();
    const foreign = await t.topUp(t.otherWorkspaceId);
    t.fake.buyer.pay(foreign.session.id);
    const sent = t.requests();

    const response = await t.check(foreign.intent.id, await t.person("owner"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "intent_not_found" });
    expect(t.requests()).toBe(sent);
    expect(
      await createBillingJournalRepository(t.db, t.otherWorkspaceId).entries({
        limit: 5,
      }),
    ).toMatchObject({ entries: [] });
  });

  // #502-T15
  it("is the missing path while billing is off and for an adapter with no lookup", async () => {
    const off = await start({ billingOn: false });
    const manual = await start({ adapter: "manual" });

    await expect(
      off.check("any", await off.person("owner")),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      manual.check("any", await manual.person("owner")),
    ).rejects.toBeInstanceOf(NotFound);
  });

  // #502-T15
  it("refuses a request from another site", async () => {
    const t = await start();
    const { intent } = await t.topUp();

    const response = await t.check(intent.id, await t.person("owner"), {
      "sec-fetch-site": "cross-site",
    });

    expect(response.status).toBe(403);
  });

  // #502-T15
  it("limits the checks of a person, since every one asks Stripe", async () => {
    const t = await start();
    const { intent } = await t.topUp();
    const owner = await t.person("owner");
    let last = 200;

    for (let i = 0; i <= CHECK_PAYMENT_REQUESTS_MAX; i += 1)
      last = (await t.check(intent.id, owner)).status;

    expect(last).toBe(429);
  });
});
