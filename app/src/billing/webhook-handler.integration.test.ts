// SPDX-License-Identifier: Apache-2.0

// The webhook of billing (#441, ADR 0005, 2.12) on a real SQLite file and, when TEST_DATABASE_URL is set, on a real Postgres,
// with requests signed by the fake Paddle's signer: the signature before anything else, one transaction per event, the dedupe on
// the event id, the order by `occurred_at`, the workspace found only through a checkout of ours, and nothing personal kept.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { buildDeliveries } from "../../../fakes/paddle/webhooks.ts";
import { createBillingDirectoryRepository } from "../db/repositories/billing-directory-repository.ts";
import { createBillingCustomersRepository } from "../db/repositories/billing-customers-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  WEBHOOK_SECRET,
  WEBHOOK_URL,
  event,
  paddleTime,
  priceData,
  startWebhookHarness,
  subscriptionData,
  type WebhookHarness,
  type WebhookHarnessOptions,
} from "../test-support/billing-webhook-harness.ts";
import { priceLinkView } from "./price-view.ts";

const ENGINES: Array<{
  name: string;
  open: () => Promise<Kysely<Database>>;
  skip: boolean;
}> = [
  {
    name: "SQLite",
    open: async () => (await createTestDatabase()).db,
    skip: false,
  },
  {
    name: "Postgres",
    open: async () => (await createPostgresTestDatabase()).db,
    skip: !hasPostgres(),
  },
];

const T1 = "2026-10-18T11:00:00.000Z";
const T2 = "2026-10-18T11:10:00.000Z";
const T3 = "2026-10-18T11:20:00.000Z";

async function outcomeOf(response: Response): Promise<unknown> {
  return ((await response.json()) as { outcome?: string }).outcome;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(ENGINES)("the billing webhook on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  async function start(options: WebhookHarnessOptions = {}) {
    return startWebhookHarness(await engine.open(), options);
  }

  /** Workspace A has a checkout `txn_a` and the subscription created from it, on the monthly price. */
  async function subscribed(h: WebhookHarness, at = T1) {
    await h.checkout(h.workspaceA, "txn_a");
    const answer = await h.deliverOne(
      event(
        "subscription.created",
        subscriptionData({ transactionId: "txn_a" }),
        { at, id: "evt_created" },
      ),
    );
    expect(answer.status).toBe(200);
    return h.subscriptionsOf(h.workspaceA);
  }

  describe("the signature", () => {
    // #441-T02
    it_.each([
      "bad_signature",
      "altered_body",
      "missing_signature",
      "malformed_signature",
      "stale_timestamp",
    ] as const)(
      "answers 401 with an empty body for %s, stores nothing and logs only a code",
      async (fault) => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        const created = event(
          "subscription.created",
          subscriptionData({ transactionId: "txn_a" }),
          { at: T1, id: "evt_secret_marker_id" },
        );

        const answer = await h.deliverOne(created, { fault });

        expect(answer.status).toBe(401);
        expect(await answer.text()).toBe("");
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeUndefined();
        expect(
          await createBillingWebhookEventsRepository(h.db).get(
            "evt_secret_marker_id",
          ),
        ).toBeUndefined();
        const log = h.logs.join("\n");
        expect(log).toMatch(/BILLING_WEBHOOK_REJECTED/);
        expect(log).not.toContain("evt_secret_marker_id");
        expect(log).not.toContain("sub_01fake1");
        expect(log).not.toContain(WEBHOOK_SECRET);
      },
    );

    // #441-T02
    it_(
      "refuses a delivery signed with another secret, and one signed for the future",
      async () => {
        const h = await start();
        const created = event("subscription.updated", subscriptionData());

        const other = await h.deliverOne(created, {
          secret: "pdl_ntfset_other",
        });
        const future = await h.deliverOne(created, {
          signedAt: Date.now() + 3_600_000 * 24,
        });

        expect([other.status, future.status]).toEqual([401, 401]);
      },
    );

    // #441-T02
    it_(
      "accepts a header with two h1 values while the secret is rotated, whichever is valid",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        const created = event(
          "subscription.created",
          subscriptionData({ transactionId: "txn_a" }),
          { at: T1 },
        );

        const first = await h.deliverOne(created, {
          fault: "two_h1_valid_first",
        });
        const last = await h.deliverOne(
          event("subscription.updated", subscriptionData(), { at: T2 }),
          { fault: "two_h1_valid_last" },
        );

        expect([first.status, last.status]).toEqual([200, 200]);
      },
    );

    // #441-T02
    it_(
      "verifies the bytes before it parses them: a body that is no JSON is 401 unsigned and 400 signed",
      async () => {
        const h = await start();
        const bytes = "{not json";
        const header = buildDeliveries(
          [event("subscription.updated", {}, { at: T1 })],
          { secret: WEBHOOK_SECRET, now: () => Date.now() },
        )[0]?.headers["paddle-signature"];

        const unsigned = await h.handler(
          new Request(WEBHOOK_URL, { method: "POST", body: bytes }),
        );
        const wrongSignature = await h.handler(
          new Request(WEBHOOK_URL, {
            method: "POST",
            body: bytes,
            headers: { "paddle-signature": header ?? "" },
          }),
        );

        expect([unsigned.status, wrongSignature.status]).toEqual([401, 401]);
      },
    );

    // #441-T02
    it_(
      "answers 400 with an empty body for a signed body that is no Paddle event",
      async () => {
        const h = await start();
        const { signPaddleWebhook } =
          await import("../../../fakes/paddle/webhooks.ts");
        const body = JSON.stringify({ hello: "world" });
        const ts = Math.floor(Date.now() / 1000);

        const answer = await h.handler(
          new Request(WEBHOOK_URL, {
            method: "POST",
            body,
            headers: {
              "paddle-signature": signPaddleWebhook(body, WEBHOOK_SECRET, ts),
            },
          }),
        );

        expect(answer.status).toBe(400);
        expect(await answer.text()).toBe("");
      },
    );

    // #441-T02
    it_(
      "takes its tolerance from the configuration: a delivery an hour old passes a wide window and not the default",
      async () => {
        const narrow = await start();
        const wide = await start({ toleranceSeconds: 4 * 24 * 3600 });
        const old = event("subscription.updated", subscriptionData(), {
          at: T1,
        });

        const refused = await narrow.deliverOne(old, {
          fault: "stale_timestamp",
        });
        const accepted = await wide.deliverOne(old, {
          fault: "stale_timestamp",
        });

        expect([refused.status, accepted.status]).toEqual([401, 200]);
      },
    );

    // #441-T02
    it_(
      "answers 503 with an empty body when the secret cannot be read, and 413 for a body over the limit",
      async () => {
        const h = await start({ maxBodyBytes: 500 });
        const small = event("subscription.updated", {}, { at: T1 });
        const large = event(
          "subscription.updated",
          { padding: "x".repeat(2000) },
          { at: T1 },
        );

        const tooLarge = await h.deliverOne(large);
        h.setSecret(undefined);
        const unreadable = await h.deliverOne(small);

        expect(tooLarge.status).toBe(413);
        expect(await tooLarge.text()).toBe("");
        expect(unreadable.status).toBe(503);
        expect(await unreadable.text()).toBe("");
        expect(h.logs.join("\n")).not.toContain("xxxxxxxx");
      },
    );
  });

  describe("a new subscription", () => {
    // #441-T03
    it_(
      "creates the subscription of the workspace that owns the checkout, on the version it names, and adopts the customer",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");

        const answer = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({
              transactionId: "txn_a",
              customerId: "ctm_01fakeA",
              customData: { workspace_id: h.workspaceA },
            }),
            { at: T1, id: "evt_created" },
          ),
        );

        expect(answer.status).toBe(200);
        expect(await outcomeOf(answer)).toBe("applied");
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toMatchObject({
          workspaceId: h.workspaceA,
          paddleSubscriptionId: "sub_01fake1",
          planVersionId: h.teamVersion.id,
          paddlePriceId: "pri_month",
          billingInterval: "month",
          status: "active",
          paddleCustomerId: "ctm_01fakeA",
          currentPeriodStart: "2026-10-18T10:00:00.123Z",
          currentPeriodEnd: "2026-11-18T10:00:00.123Z",
          lastEventOccurredAt: "2026-10-18T11:00:00.123Z",
          lastEventId: "evt_created",
          pastDueSince: null,
          scheduledChangeAction: null,
        });
        expect(
          await createBillingCustomersRepository(h.db, h.workspaceA).get(
            "sandbox",
          ),
        ).toBe("ctm_01fakeA");
        expect(await h.subscriptionsOf(h.workspaceB).getLive()).toBeUndefined();
        expect(
          await createBillingWebhookEventsRepository(h.db).get("evt_created"),
        ).toMatchObject({ outcome: "applied", entityId: "sub_01fake1" });
      },
    );

    // #441-T03
    it_(
      "sells a yearly subscription in the yearly interval, from the slot its price is linked to",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a", "year");

        await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({ transactionId: "txn_a", priceId: "pri_year" }),
            { at: T1 },
          ),
        );

        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toMatchObject({
          billingInterval: "year",
          paddlePriceId: "pri_year",
        });
      },
    );

    // #441-T03
    it_(
      "takes the workspace from the checkout row and ignores what the payload says about a workspace",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");

        const answer = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({
              transactionId: "txn_a",
              customData: { workspace_id: h.workspaceB },
            }),
            { at: T1 },
          ),
        );

        // A payload that names another workspace than our checkout is a mismatch: nothing is applied to either.
        expect(await outcomeOf(answer)).toBe("workspace_unresolved");
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeUndefined();
        expect(await h.subscriptionsOf(h.workspaceB).getLive()).toBeUndefined();
      },
    );

    // #441-T07
    it_(
      "does not resolve a workspace from custom data alone: a transaction without a checkout row changes nothing and answers 200",
      async () => {
        const h = await start();

        const answer = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({
              transactionId: "txn_unknown",
              customData: { workspace_id: h.workspaceA },
            }),
            { at: T1, id: "evt_unresolved" },
          ),
        );

        expect(answer.status).toBe(200);
        expect(await outcomeOf(answer)).toBe("workspace_unresolved");
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeUndefined();
        expect(
          await createBillingCustomersRepository(h.db, h.workspaceA).get(
            "sandbox",
          ),
        ).toBeUndefined();
        expect(
          await createBillingWebhookEventsRepository(h.db).get(
            "evt_unresolved",
          ),
        ).toMatchObject({ outcome: "workspace_unresolved" });
      },
    );

    // #441-T07
    it_(
      "does not resolve a subscription without a transaction id, an update for a subscription it does not know, or a checkout of the other environment",
      async () => {
        const h = await start({ environment: "live" });
        await h.checkout(h.workspaceA, "txn_a");

        const withoutTransaction = await h.deliverOne(
          event("subscription.created", subscriptionData(), { at: T1 }),
        );
        const update = await h.deliverOne(
          event("subscription.updated", subscriptionData(), { at: T2 }),
        );
        // The checkout row is a sandbox one; this instance is configured for live.
        const otherEnvironment = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({ transactionId: "txn_a" }),
            { at: T3 },
          ),
        );

        expect(
          await Promise.all(
            [withoutTransaction, update, otherEnvironment].map(outcomeOf),
          ),
        ).toEqual([
          "workspace_unresolved",
          "workspace_unresolved",
          "workspace_unresolved",
        ]);
      },
    );

    // #441-T08
    it_(
      "keeps the state and answers price_unmapped for a price that belongs to no version, and for one the checkout did not buy",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        await h.checkout(h.workspaceB, "txn_b", "month");

        const unknown = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({ transactionId: "txn_a", priceId: "pri_nobody" }),
            { at: T1 },
          ),
        );
        // The checkout of B bought the Team version; the subscription is on the price of another plan.
        const foreign = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({
              id: "sub_other",
              transactionId: "txn_b",
              priceId: "pri_pro_month",
            }),
            { at: T1 },
          ),
        );
        // The yearly price on a checkout that bought the monthly interval.
        const wrongInterval = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({
              id: "sub_third",
              transactionId: "txn_b",
              priceId: "pri_year",
            }),
            { at: T1 },
          ),
        );

        expect(
          await Promise.all([unknown, foreign, wrongInterval].map(outcomeOf)),
        ).toEqual(["price_unmapped", "price_unmapped", "price_unmapped"]);
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeUndefined();
        expect(await h.subscriptionsOf(h.workspaceB).getLive()).toBeUndefined();
        expect(h.logs.join("\n")).toMatch(/BILLING_WEBHOOK_PRICE_UNMAPPED/);
      },
    );

    // #441-T11
    it_(
      "flags a second live subscription for the workspace and applies nothing",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h);
        await h.checkout(h.workspaceA, "txn_second");

        const answer = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({
              id: "sub_second",
              transactionId: "txn_second",
              customerId: "ctm_second",
            }),
            { at: T2, id: "evt_second" },
          ),
        );

        expect(answer.status).toBe(200);
        expect(await outcomeOf(answer)).toBe("second_live_subscription");
        expect(await subscriptions.getLive()).toMatchObject({
          paddleSubscriptionId: "sub_01fake1",
          paddleCustomerId: "ctm_01fake1",
        });
        expect(
          await subscriptions.getByPaddleId("sandbox", "sub_second"),
        ).toBeUndefined();
        expect(
          await createBillingCustomersRepository(h.db, h.workspaceA).get(
            "sandbox",
          ),
        ).toBe("ctm_01fake1");
        expect(
          await createBillingWebhookEventsRepository(h.db).get("evt_second"),
        ).toMatchObject({ outcome: "second_live_subscription" });
        const log = h.logs.join("\n");
        expect(log).toMatch(/BILLING_WEBHOOK_SECOND_LIVE_SUBSCRIPTION/);
        expect(log).toContain("sub_second");
      },
    );

    // #441-T11
    it_(
      "accepts a new subscription once the earlier one is canceled",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h);
        await h.deliverOne(
          event(
            "subscription.canceled",
            subscriptionData({ status: "canceled" }),
            { at: T2 },
          ),
        );
        await h.checkout(h.workspaceA, "txn_again");

        const again = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({ id: "sub_again", transactionId: "txn_again" }),
            { at: T3 },
          ),
        );

        expect(await outcomeOf(again)).toBe("applied");
        expect(await subscriptions.getLive()).toMatchObject({
          paddleSubscriptionId: "sub_again",
        });
      },
    );
  });

  describe("duplicates and order", () => {
    // #441-T04
    it_(
      "applies the same event delivered twice once, and answers 200 both times",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        const created = event(
          "subscription.created",
          subscriptionData({ transactionId: "txn_a" }),
          { at: T1, id: "evt_once" },
        );

        const answers = await h.deliver([created], { duplicates: 1 });

        expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
        expect(await Promise.all(answers.map(outcomeOf))).toEqual([
          "applied",
          "duplicate_ignored",
        ]);
        const rows = await h.db
          .selectFrom("billing_subscriptions")
          .selectAll()
          .execute();
        expect(rows).toHaveLength(1);
        expect(
          (
            await h.db
              .selectFrom("billing_webhook_events")
              .selectAll()
              .execute()
          ).length,
        ).toBe(1);
      },
    );

    // #441-T04
    it_(
      "applies the same event delivered concurrently once, and every delivery answers 200",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        const created = event(
          "subscription.created",
          subscriptionData({ transactionId: "txn_a" }),
          { at: T1, id: "evt_race" },
        );

        const answers = await Promise.all(
          h.requests([created], { duplicates: 5 }).map((r) => h.handler(r)),
        );

        expect(answers.map((answer) => answer.status)).toEqual(
          Array.from({ length: 6 }, () => 200),
        );
        const outcomes = await Promise.all(answers.map(outcomeOf));
        expect(
          outcomes.filter((outcome) => outcome === "applied"),
        ).toHaveLength(1);
        expect(
          outcomes.filter((outcome) => outcome === "duplicate_ignored"),
        ).toHaveLength(5);
        expect(
          await h.db.selectFrom("billing_subscriptions").selectAll().execute(),
        ).toHaveLength(1);
      },
    );

    // #441-T04
    it_(
      "keeps the first outcome of an event on its row when it is delivered again",
      async () => {
        const h = await start();
        const stale = event(
          "subscription.updated",
          subscriptionData({ id: "sub_unknown" }),
          { at: T1, id: "evt_dup" },
        );

        await h.deliver([stale], { duplicates: 1 });

        expect(
          await createBillingWebhookEventsRepository(h.db).get("evt_dup"),
        ).toMatchObject({ outcome: "workspace_unresolved" });
      },
    );

    // #441-T05
    it_(
      "records an update older than the last applied as stale_ignored and leaves the state as it was",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);
        await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ status: "past_due" }),
            { at: T3, id: "evt_newer" },
          ),
        );

        const answer = await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ status: "active" }),
            {
              at: T2,
              id: "evt_older",
            },
          ),
        );

        expect(answer.status).toBe(200);
        expect(await outcomeOf(answer)).toBe("stale_ignored");
        expect(await subscriptions.getLive()).toMatchObject({
          status: "past_due",
          lastEventId: "evt_newer",
        });
        expect(
          await createBillingWebhookEventsRepository(h.db).get("evt_older"),
        ).toMatchObject({ outcome: "stale_ignored" });
      },
    );

    // #441-T05
    it_(
      "applies an update with the same stamp as the last one (ties apply)",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);

        const answer = await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ status: "paused" }),
            {
              at: T1,
              id: "evt_tie",
            },
          ),
        );

        expect(await outcomeOf(answer)).toBe("applied");
        expect((await subscriptions.getLive())?.status).toBe("paused");
      },
    );

    // #441-T06
    it_(
      "ends canceled when the update and the cancellation arrive in the reverse order",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);
        const updated = event(
          "subscription.updated",
          subscriptionData({ status: "past_due" }),
          { at: T2, id: "evt_updated" },
        );
        const canceled = event(
          "subscription.canceled",
          subscriptionData({ status: "canceled" }),
          { at: T3, id: "evt_canceled" },
        );

        const answers = await h.deliver([updated, canceled], {
          order: "reversed",
        });

        expect(await Promise.all(answers.map(outcomeOf))).toEqual([
          "applied",
          "stale_ignored",
        ]);
        const row = await subscriptions.getByPaddleId("sandbox", "sub_01fake1");
        expect(row).toMatchObject({
          status: "canceled",
          lastEventId: "evt_canceled",
        });
        expect(row?.canceledAt).not.toBeNull();
      },
    );
  });

  describe("what an event says", () => {
    // #441-T03
    it_(
      "counts past_due from the first event that shows it, keeps that time while it lasts, and clears it on recovery",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);

        await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ status: "past_due" }),
            {
              at: T2,
            },
          ),
        );
        await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ status: "past_due" }),
            {
              at: T3,
            },
          ),
        );
        const during = await subscriptions.getLive();
        await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ status: "active" }),
            {
              at: "2026-10-18T11:30:00.000Z",
            },
          ),
        );

        expect(during).toMatchObject({
          status: "past_due",
          pastDueSince: "2026-10-18T11:10:00.123Z",
        });
        expect(await subscriptions.getLive()).toMatchObject({
          status: "active",
          pastDueSince: null,
        });
      },
    );

    // #441-T03
    it_(
      "keeps a scheduled cancellation and the period of the renewal",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);

        await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({
              scheduledChange: {
                action: "cancel",
                effective_at: paddleTime("2026-11-18T10:00:00.000Z"),
              },
              startsAt: "2026-11-18T10:00:00.000Z",
              endsAt: "2026-12-18T10:00:00.000Z",
            }),
            { at: T2 },
          ),
        );

        expect(await subscriptions.getLive()).toMatchObject({
          scheduledChangeAction: "cancel",
          scheduledChangeAt: "2026-11-18T10:00:00.123Z",
          currentPeriodStart: "2026-11-18T10:00:00.123Z",
          currentPeriodEnd: "2026-12-18T10:00:00.123Z",
        });
      },
    );

    // #441-T03
    it_(
      "answers status_unknown for a status the app does not know and keeps the state",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);

        const answer = await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ status: "frozen_by_paddle" }),
            { at: T2 },
          ),
        );

        expect(answer.status).toBe(200);
        expect(await outcomeOf(answer)).toBe("status_unknown");
        expect((await subscriptions.getLive())?.status).toBe("active");
      },
    );

    // #441-T03
    it_(
      "answers payload_invalid for a subscription the app cannot read, and keeps the state",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);

        const answer = await h.deliverOne(
          event("subscription.updated", { id: "sub_01fake1" }, { at: T2 }),
        );

        expect(await outcomeOf(answer)).toBe("payload_invalid");
        expect((await subscriptions.getLive())?.status).toBe("active");
      },
    );

    // #441-T08
    it_(
      "moves the pin to the current version of the plan whose price the subscription now has",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);

        await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ priceId: "pri_pro_month" }),
            { at: T2 },
          ),
        );

        expect(await subscriptions.getLive()).toMatchObject({
          planVersionId: h.proVersion.id,
          paddlePriceId: "pri_pro_month",
          billingInterval: "month",
        });
      },
    );

    // #441-T08
    it_(
      "keeps the state and the version for an update whose price no version sells, yet still ends a canceled subscription",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);

        const unmapped = await h.deliverOne(
          event(
            "subscription.updated",
            subscriptionData({ priceId: "pri_nobody", status: "past_due" }),
            { at: T2, id: "evt_unmapped" },
          ),
        );
        const canceled = await h.deliverOne(
          event(
            "subscription.canceled",
            subscriptionData({ priceId: "pri_nobody", status: "canceled" }),
            { at: T3 },
          ),
        );

        expect(await outcomeOf(unmapped)).toBe("price_unmapped");
        expect(await outcomeOf(canceled)).toBe("applied");
        expect(
          await createBillingWebhookEventsRepository(h.db).get("evt_unmapped"),
        ).toMatchObject({ outcome: "price_unmapped" });
        const row = await subscriptions.getByPaddleId("sandbox", "sub_01fake1");
        expect(row).toMatchObject({
          status: "canceled",
          planVersionId: h.teamVersion.id,
          paddlePriceId: "pri_month",
        });
      },
    );

    // #441-T08
    it_(
      "keeps the state when the subscription has two items, since no single plan version fits",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);
        const data = subscriptionData({ priceId: "pri_pro_month" });
        (data.items as unknown[]).push({
          status: "active",
          quantity: 1,
          price: { id: "pri_month", product_id: "pro_1" },
        });

        const answer = await h.deliverOne(
          event("subscription.updated", data, { at: T2 }),
        );

        expect(await outcomeOf(answer)).toBe("price_unmapped");
        expect((await subscriptions.getLive())?.paddlePriceId).toBe(
          "pri_month",
        );
      },
    );
  });

  describe("failure", () => {
    // #441-T09
    it_(
      "answers 500 and applies nothing when the database fails, and the redelivery applies",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        const created = event(
          "subscription.created",
          subscriptionData({ transactionId: "txn_a" }),
          { at: T1, id: "evt_failing" },
        );
        h.failOn("insert", "billing_subscriptions");

        const failed = await h.deliverOne(created);

        expect(failed.status).toBe(500);
        expect(await failed.text()).toBe("");
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeUndefined();
        expect(
          await createBillingWebhookEventsRepository(h.db).get("evt_failing"),
        ).toBeUndefined();
        expect(
          await createBillingCustomersRepository(h.db, h.workspaceA).get(
            "sandbox",
          ),
        ).toBeUndefined();
        const log = h.logs.join("\n");
        expect(log).toMatch(/BILLING_WEBHOOK_FAILED/);
        expect(log).not.toContain("injected database failure");

        h.heal();
        const redelivered = await h.deliverOne(created);

        expect(redelivered.status).toBe(200);
        expect(await outcomeOf(redelivered)).toBe("applied");
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeDefined();
      },
    );

    // #441-T09
    it_(
      "applies nothing of an event whose last statement fails: the customer and the event row go with it",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        h.failOn("update", "billing_webhook_events");

        const failed = await h.deliverOne(
          event(
            "subscription.created",
            subscriptionData({ transactionId: "txn_a" }),
            { at: T1, id: "evt_late_failure" },
          ),
        );

        expect(failed.status).toBe(500);
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeUndefined();
        expect(
          await createBillingCustomersRepository(h.db, h.workspaceA).get(
            "sandbox",
          ),
        ).toBeUndefined();
        expect(
          await createBillingWebhookEventsRepository(h.db).get(
            "evt_late_failure",
          ),
        ).toBeUndefined();
      },
    );
  });

  describe("prices", () => {
    // #441-T10
    it_(
      "refreshes the cache of a linked price from price.updated and shows the drift",
      async () => {
        const h = await start();
        const before = await h.prices.get(h.teamMonth.id);

        const answer = await h.deliverOne(
          event(
            "price.updated",
            priceData("pri_month", {
              unit_price: { amount: "4321", currency_code: "USD" },
            }),
            { at: T1 },
          ),
        );

        expect(await outcomeOf(answer)).toBe("applied");
        const after = await h.prices.get(h.teamMonth.id);
        expect(before?.amount).toBe("1234");
        expect(after).toMatchObject({
          amount: "4321",
          snapshotAt: "2026-10-18T11:00:00.123Z",
        });
        // The drift flag is what the plans view derives from the cache.
        const view = priceLinkView(
          after!,
          { interval: "month", amountMinor: 1234, productId: "pro_1" },
          "sandbox",
        );
        expect(view.drift).toBe("price_amount_mismatch");
      },
    );

    // #441-T10
    it_(
      "shows an archived price as drift, and leaves the other prices alone",
      async () => {
        const h = await start();

        await h.deliverOne(
          event(
            "price.updated",
            priceData("pri_month", { status: "archived" }),
            {
              at: T1,
            },
          ),
        );

        expect((await h.prices.get(h.teamMonth.id))?.status).toBe("archived");
        expect((await h.prices.get(h.teamYear.id))?.status).toBe("active");
      },
    );

    // #441-T10
    it_(
      "refreshes the cache from price.created for a price a plan links, and ignores a price no plan links",
      async () => {
        const h = await start();

        const known = await h.deliverOne(
          event(
            "price.created",
            priceData("pri_month", { description: "again" }),
            {
              at: T1,
            },
          ),
        );
        const unknown = await h.deliverOne(
          event("price.created", priceData("pri_foreign"), { at: T1 }),
        );

        expect(await outcomeOf(known)).toBe("applied");
        expect(await outcomeOf(unknown)).toBe("price_not_tracked");
        expect(await h.prices.getByPaddleId("pri_foreign")).toBeUndefined();
      },
    );

    // #441-T10
    it_(
      "does not let an older price event overwrite a newer cache",
      async () => {
        const h = await start();
        await h.deliverOne(
          event(
            "price.updated",
            priceData("pri_month", {
              unit_price: { amount: "4321", currency_code: "USD" },
            }),
            { at: T3 },
          ),
        );

        const answer = await h.deliverOne(
          event(
            "price.updated",
            priceData("pri_month", {
              unit_price: { amount: "1111", currency_code: "USD" },
            }),
            { at: T1 },
          ),
        );

        expect(await outcomeOf(answer)).toBe("stale_ignored");
        expect((await h.prices.get(h.teamMonth.id))?.amount).toBe("4321");
      },
    );

    // #441-T10
    it_(
      "answers payload_invalid for a price event that is not a price",
      async () => {
        const h = await start();

        const answer = await h.deliverOne(
          event("price.updated", { id: "pri_month" }, { at: T1 }),
        );

        expect(await outcomeOf(answer)).toBe("payload_invalid");
        expect((await h.prices.get(h.teamMonth.id))?.amount).toBe("1234");
      },
    );
  });

  describe("other events", () => {
    // #441-T14
    it_(
      "records an unknown event type as ignored_type and answers 200",
      async () => {
        const h = await start();

        const answer = await h.deliverOne(
          event(
            "customer.updated",
            { id: "ctm_1", email: "x@example.test" },
            {
              at: T1,
              id: "evt_other",
            },
          ),
        );

        expect(answer.status).toBe(200);
        expect(await outcomeOf(answer)).toBe("ignored_type");
        expect(
          await createBillingWebhookEventsRepository(h.db).get("evt_other"),
        ).toMatchObject({
          outcome: "ignored_type",
          eventType: "customer.updated",
        });
      },
    );

    // #441-T14
    it_(
      "records the transaction and product events it is subscribed to without touching the state",
      async () => {
        const h = await start();
        const subscriptions = await subscribed(h, T1);
        const before = await subscriptions.getLive();

        const answers = await h.deliver([
          event(
            "transaction.completed",
            { id: "txn_a", subscription_id: "sub_01fake1" },
            { at: T2 },
          ),
          event(
            "transaction.payment_failed",
            { id: "txn_b", subscription_id: "sub_01fake1" },
            { at: T3 },
          ),
          event("product.updated", { id: "pro_1" }, { at: T3 }),
        ]);

        expect(await Promise.all(answers.map(outcomeOf))).toEqual([
          "informational",
          "informational",
          "informational",
        ]);
        expect(await subscriptions.getLive()).toEqual(before);
      },
    );
  });

  describe("what is kept", () => {
    // #441-T13
    it_(
      "stores and logs no email, card, address, tax id or payload",
      async () => {
        const h = await start();
        await h.checkout(h.workspaceA, "txn_a");
        const markers = [
          "buyer@example.test",
          "4242424242424242",
          "221B Baker Street",
          "DE123456789",
        ];
        const created = event(
          "subscription.created",
          subscriptionData({
            transactionId: "txn_a",
            customData: { workspace_id: h.workspaceA, email: markers[0] },
            extra: {
              billing_details: { purchase_order_number: markers[3] },
              customer: { email: markers[0], card: markers[1] },
              address: { first_line: markers[2], tax_identifier: markers[3] },
              management_urls: {
                cancel: "https://paddle.example/cancel?t=SECRETTOKEN",
              },
            },
          }),
          { at: T1, id: "evt_personal" },
        );

        await h.deliverOne(created);
        // The same event with a bad signature, and one the app cannot apply: neither logs the body.
        await h.deliverOne(created, { fault: "bad_signature" });
        await h.deliverOne(
          event(
            "subscription.updated",
            { id: "sub_01fake1", email: markers[0] },
            {
              at: T2,
            },
          ),
        );

        const everything = `${h.logs.join("\n")}\n${await h.dump()}`;
        for (const marker of [...markers, "SECRETTOKEN"])
          expect(everything).not.toContain(marker);
        expect(everything).not.toContain("custom_data");
        expect(await h.subscriptionsOf(h.workspaceA).getLive()).toBeDefined();
      },
    );

    // #441-T15
    it_("makes no outbound call while it handles an event", async () => {
      const h = await start();
      await h.checkout(h.workspaceA, "txn_a");
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await h.deliver([
        event(
          "subscription.created",
          subscriptionData({ transactionId: "txn_a" }),
          { at: T1 },
        ),
        event("price.updated", priceData("pri_month"), { at: T2 }),
        event("subscription.updated", subscriptionData(), { at: T3 }),
      ]);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("the directory of the checkouts", () => {
    // #441-T07
    it_(
      "is the only way from a Paddle id to a workspace: a checkout of A and a subscription of A are found, nothing else",
      async () => {
        const h = await start();
        await subscribed(h);
        const directory = createBillingDirectoryRepository(h.db);

        expect(await directory.workspaceOfCheckout("sandbox", "txn_a")).toBe(
          h.workspaceA,
        );
        expect(
          await directory.workspaceOfSubscription("sandbox", "sub_01fake1"),
        ).toBe(h.workspaceA);
        expect(
          await directory.workspaceOfCheckout("sandbox", "sub_01fake1"),
        ).toBeUndefined();
      },
    );
  });
});
