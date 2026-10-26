// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the webhook_deliveries table against a real Postgres database: the first request with a
// delivery id claims it, a delivery that succeeded is a duplicate, one that was turned away or failed
// can be claimed again (GitHub's "Redeliver" keeps the id), a request that arrives during another is
// "in progress", only the owner of a claim can finish it, and old rows disappear.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  createWebhookDeliveriesRepository,
  WEBHOOK_DELIVERY_PROCESSING_LEASE_MS,
  WEBHOOK_DELIVERY_PRUNE_INTERVAL_MS,
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  type WebhookDeliveryClaim,
} from "./webhook-deliveries-repository.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const { db } = await createTestDatabase();
  let nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);
  let counter = 0;
  const clock = {
    advance(ms: number) {
      nowMs += ms;
    },
  };
  const deliveries = createWebhookDeliveriesRepository(
    db,
    () => new Date(nowMs),
    () => `token-${++counter}`,
  );
  const rows = () =>
    db
      .selectFrom("webhook_deliveries")
      .selectAll()
      .orderBy("delivery_id")
      .execute();
  return { db, clock, deliveries, rows };
}

function tokenOf(claim: WebhookDeliveryClaim): string {
  if (claim.status !== "claimed")
    throw new Error(`expected a claim, got ${claim.status}`);
  return claim.token;
}

describe("claiming a delivery", () => {
  it("lets the first request with an id claim it and tells later ones it is in progress", async () => {
    const { deliveries, rows } = await setup();

    expect(await deliveries.claim("d-1", "pull_request")).toEqual({
      status: "claimed",
      token: "token-1",
    });
    expect(await deliveries.claim("d-1", "pull_request")).toEqual({
      status: "in_progress",
    });
    expect(await deliveries.claim("d-2", "issue_comment")).toMatchObject({
      status: "claimed",
    });

    expect(await rows()).toEqual([
      {
        delivery_id: "d-1",
        event: "pull_request",
        outcome: "processing",
        claim_token: "token-1",
        received_at: "2026-10-10T12:00:00.000Z",
      },
      expect.objectContaining({ delivery_id: "d-2", event: "issue_comment" }),
    ]);
  });

  // CR-22-T08
  it("lets exactly one of many simultaneous requests with the same id claim it", async () => {
    const { deliveries } = await setup();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => deliveries.claim("d-1", "pull_request")),
    );

    expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "in_progress")).toHaveLength(9);
  });

  it.each(["trigger_enqueued", "installation_changed"] as const)(
    "calls a delivery that ended with %s a duplicate, however old it is",
    async (outcome) => {
      const { deliveries, clock, rows } = await setup();
      const token = tokenOf(await deliveries.claim("d-1", "pull_request"));
      await deliveries.complete("d-1", token, outcome);

      clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS * 10);

      expect(await deliveries.claim("d-1", "pull_request")).toEqual({
        status: "duplicate",
      });
      expect((await rows())[0]).toMatchObject({ outcome });
    },
  );

  it.each([
    "ignored",
    "unknown_installation",
    "integration_disabled",
    "trigger_not_allowed",
  ] as const)(
    "records %s but lets the redelivery of the same id be claimed again",
    async (outcome) => {
      const { deliveries, rows } = await setup();
      const token = tokenOf(await deliveries.claim("d-1", "pull_request"));
      await deliveries.complete("d-1", token, outcome);
      expect((await rows())[0]).toMatchObject({ outcome });

      const again = await deliveries.claim("d-1", "pull_request");

      expect(again).toMatchObject({ status: "claimed" });
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({ outcome: "processing" });
    },
  );
});

describe("releasing a delivery", () => {
  // CR-22-T13
  it("lets a redelivery of a failed delivery be claimed again", async () => {
    const { deliveries, rows } = await setup();
    const token = tokenOf(await deliveries.claim("d-1", "pull_request"));

    await deliveries.release("d-1", token);

    expect(await rows()).toEqual([]);
    expect(await deliveries.claim("d-1", "pull_request")).toMatchObject({
      status: "claimed",
    });
  });

  it("does not remove a delivery that has an outcome", async () => {
    const { deliveries, rows } = await setup();
    const token = tokenOf(await deliveries.claim("d-1", "pull_request"));
    await deliveries.complete("d-1", token, "trigger_enqueued");

    await deliveries.release("d-1", token);

    expect(await rows()).toHaveLength(1);
  });
});

describe("a claim that was never completed", () => {
  it("stays in progress while its lease is running", async () => {
    const { deliveries, clock } = await setup();
    await deliveries.claim("d-1", "pull_request");

    clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS - 1);

    expect(await deliveries.claim("d-1", "pull_request")).toEqual({
      status: "in_progress",
    });
  });

  it("can be taken over once the lease ran out, because the first request must have died", async () => {
    const { deliveries, clock, rows } = await setup();
    await deliveries.claim("d-1", "pull_request");

    clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS + 1);

    expect(await deliveries.claim("d-1", "pull_request")).toMatchObject({
      status: "claimed",
    });
    expect(await deliveries.claim("d-1", "pull_request")).toEqual({
      status: "in_progress",
    });
    expect(await rows()).toHaveLength(1);
  });
});

describe("the owner of a claim", () => {
  it("is the only one who can complete it", async () => {
    const { deliveries, clock, rows } = await setup();
    const stalled = tokenOf(await deliveries.claim("d-1", "pull_request"));
    clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS + 1);
    const taker = tokenOf(await deliveries.claim("d-1", "pull_request"));

    await deliveries.complete("d-1", stalled, "trigger_enqueued");

    expect((await rows())[0]).toMatchObject({
      outcome: "processing",
      claim_token: taker,
    });
    await deliveries.complete("d-1", taker, "trigger_enqueued");
    expect((await rows())[0]).toMatchObject({ outcome: "trigger_enqueued" });
  });

  it("is the only one who can release it", async () => {
    const { deliveries, clock, rows } = await setup();
    const stalled = tokenOf(await deliveries.claim("d-1", "pull_request"));
    clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS + 1);
    const taker = tokenOf(await deliveries.claim("d-1", "pull_request"));

    await deliveries.release("d-1", stalled);

    expect(await rows()).toHaveLength(1);
    expect(await deliveries.claim("d-1", "pull_request")).toEqual({
      status: "in_progress",
    });
    await deliveries.release("d-1", taker);
    expect(await rows()).toEqual([]);
  });
});

describe("pruning", () => {
  it("removes deliveries older than the retention period when a delivery is claimed after the prune interval", async () => {
    const { deliveries, clock, rows } = await setup();
    await deliveries.claim("old", "pull_request");
    clock.advance(WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS - 1);
    await deliveries.claim("recent", "pull_request");
    expect((await rows()).map((row) => row.delivery_id)).toEqual([
      "old",
      "recent",
    ]);

    clock.advance(WEBHOOK_DELIVERY_PRUNE_INTERVAL_MS + 2);
    await deliveries.claim("newest", "pull_request");

    expect((await rows()).map((row) => row.delivery_id)).toEqual([
      "newest",
      "recent",
    ]);
  });

  it("runs at most once per prune interval", async () => {
    const { db, deliveries, clock, rows } = await setup();
    await deliveries.claim("first", "pull_request");
    await db
      .insertInto("webhook_deliveries")
      .values({
        delivery_id: "ancient",
        event: "pull_request",
        outcome: "ignored",
        claim_token: "t",
        received_at: "2026-01-01T00:00:00.000Z",
      })
      .execute();

    clock.advance(60_000);
    await deliveries.claim("second", "pull_request");
    expect((await rows()).map((row) => row.delivery_id)).toContain("ancient");

    clock.advance(WEBHOOK_DELIVERY_PRUNE_INTERVAL_MS);
    await deliveries.claim("third", "pull_request");
    expect((await rows()).map((row) => row.delivery_id)).not.toContain(
      "ancient",
    );
  });

  it("lets a pruned delivery id be claimed again", async () => {
    const { deliveries, clock } = await setup();
    const token = tokenOf(await deliveries.claim("d-1", "pull_request"));
    await deliveries.complete("d-1", token, "trigger_enqueued");

    clock.advance(WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS + 1);

    expect(await deliveries.claim("d-1", "pull_request")).toMatchObject({
      status: "claimed",
    });
  });
});
