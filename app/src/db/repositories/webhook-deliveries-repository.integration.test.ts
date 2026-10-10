// Pins down the webhook_deliveries table against a real SQLite file: the first request with a
// delivery id claims it, every later one is a duplicate, a failed delivery can be claimed again, and
// old rows disappear whenever a new one is written.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  createWebhookDeliveriesRepository,
  WEBHOOK_DELIVERY_PROCESSING_LEASE_MS,
  WEBHOOK_DELIVERY_RETENTION_DAYS,
} from "./webhook-deliveries-repository.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const { db } = await createTestDatabase();
  let nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);
  const clock = {
    advance(ms: number) {
      nowMs += ms;
    },
  };
  const deliveries = createWebhookDeliveriesRepository(
    db,
    () => new Date(nowMs),
  );
  const rows = () =>
    db
      .selectFrom("webhook_deliveries")
      .selectAll()
      .orderBy("delivery_id")
      .execute();
  return { db, clock, deliveries, rows };
}

describe("claiming a delivery", () => {
  it("lets the first request with an id claim it and calls every later one a duplicate", async () => {
    const { deliveries, rows } = await setup();

    expect(await deliveries.claim("d-1", "pull_request")).toBe("claimed");
    expect(await deliveries.claim("d-1", "pull_request")).toBe("duplicate");
    expect(await deliveries.claim("d-2", "issue_comment")).toBe("claimed");

    expect(await rows()).toEqual([
      {
        delivery_id: "d-1",
        event: "pull_request",
        outcome: "processing",
        received_at: "2026-10-10T12:00:00.000Z",
      },
      {
        delivery_id: "d-2",
        event: "issue_comment",
        outcome: "processing",
        received_at: "2026-10-10T12:00:00.000Z",
      },
    ]);
  });

  // CR-22-T08
  it("lets exactly one of many simultaneous requests with the same id claim it", async () => {
    const { deliveries } = await setup();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => deliveries.claim("d-1", "pull_request")),
    );

    expect(results.filter((result) => result === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(9);
  });

  it("keeps a delivery claimed after its outcome was recorded", async () => {
    const { deliveries, rows } = await setup();
    await deliveries.claim("d-1", "pull_request");

    await deliveries.complete("d-1", "trigger_enqueued");

    expect(await deliveries.claim("d-1", "pull_request")).toBe("duplicate");
    expect((await rows())[0]).toMatchObject({ outcome: "trigger_enqueued" });
  });
});

describe("releasing a delivery", () => {
  // CR-22-T13
  it("lets a redelivery of a failed delivery be claimed again", async () => {
    const { deliveries, rows } = await setup();
    await deliveries.claim("d-1", "pull_request");

    await deliveries.release("d-1");

    expect(await rows()).toEqual([]);
    expect(await deliveries.claim("d-1", "pull_request")).toBe("claimed");
  });

  it("does not remove a delivery that has an outcome", async () => {
    const { deliveries, rows } = await setup();
    await deliveries.claim("d-1", "pull_request");
    await deliveries.complete("d-1", "trigger_enqueued");

    await deliveries.release("d-1");

    expect(await rows()).toHaveLength(1);
  });
});

describe("a claim that was never completed", () => {
  it("stays a duplicate while its processing lease is running", async () => {
    const { deliveries, clock } = await setup();
    await deliveries.claim("d-1", "pull_request");

    clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS - 1);

    expect(await deliveries.claim("d-1", "pull_request")).toBe("duplicate");
  });

  it("can be taken over once the lease ran out, because the first request must have died", async () => {
    const { deliveries, clock, rows } = await setup();
    await deliveries.claim("d-1", "pull_request");

    clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS + 1);

    expect(await deliveries.claim("d-1", "pull_request")).toBe("claimed");
    expect(await deliveries.claim("d-1", "pull_request")).toBe("duplicate");
    expect(await rows()).toHaveLength(1);
  });

  it("is not taken over when it has an outcome, however old it is", async () => {
    const { deliveries, clock } = await setup();
    await deliveries.claim("d-1", "pull_request");
    await deliveries.complete("d-1", "ignored");

    clock.advance(WEBHOOK_DELIVERY_PROCESSING_LEASE_MS * 10);

    expect(await deliveries.claim("d-1", "pull_request")).toBe("duplicate");
  });
});

describe("pruning", () => {
  it("removes deliveries older than the retention period when a new one is written", async () => {
    const { deliveries, clock, rows } = await setup();
    await deliveries.claim("old", "pull_request");
    await deliveries.complete("old", "ignored");
    clock.advance(WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS - 1);
    await deliveries.claim("recent", "pull_request");
    expect((await rows()).map((row) => row.delivery_id)).toEqual([
      "old",
      "recent",
    ]);

    clock.advance(2);
    await deliveries.claim("newest", "pull_request");

    expect((await rows()).map((row) => row.delivery_id)).toEqual([
      "newest",
      "recent",
    ]);
  });

  it("lets a pruned delivery id be claimed again", async () => {
    const { deliveries, clock } = await setup();
    await deliveries.claim("d-1", "pull_request");
    await deliveries.complete("d-1", "ignored");

    clock.advance(WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS + 1);

    expect(await deliveries.claim("d-1", "pull_request")).toBe("claimed");
  });
});
