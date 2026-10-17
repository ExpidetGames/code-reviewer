// SPDX-License-Identifier: Apache-2.0

// Pins down the webhook signer and the deliveries of the fake Paddle (fakes/paddle/webhooks.ts) without a server:
// what `deliver()` would send for a duplicate, a reordered, a stale and a tampered case. The route tests of
// the billing epic (#421) rely on these requests, and the verifier of the app (src/billing) must agree with
// the signer, so a wrong signer fails here first.
import { describe, expect, it } from "vitest";
import {
  buildDeliveries,
  deliver,
  makeEvent,
  serializeEvent,
  signPaddleWebhook,
  type PaddleDelivery,
} from "../../../fakes/paddle/webhooks.ts";
import { verifyPaddleSignature } from "../billing/webhook-verify.ts";

const SECRET = "pdl_ntfset_test_secret_value";
const NOW_MS = Date.parse("2026-10-17T12:00:00Z");
const NOW_SECONDS = NOW_MS / 1000;
const now = () => NOW_MS;

const first = makeEvent(
  "subscription.updated",
  { id: "sub_01fake0001", status: "active" },
  { occurredAt: "2026-10-17T11:00:00.000Z", eventId: "evt_01fake0001" },
);
const second = makeEvent(
  "subscription.canceled",
  { id: "sub_01fake0001", status: "canceled" },
  { occurredAt: "2026-10-17T11:30:00.000Z", eventId: "evt_01fake0002" },
);

function verdict(delivery: PaddleDelivery) {
  return verifyPaddleSignature({
    header: delivery.headers["paddle-signature"],
    rawBody: delivery.body,
    secret: SECRET,
    now: new Date(NOW_MS),
  });
}

const eventIds = (deliveries: PaddleDelivery[]) =>
  deliveries.map((delivery) => delivery.eventId);

describe("signPaddleWebhook and makeEvent", () => {
  // #436-T12
  it("signs ts:body with HMAC-SHA256, like the known vector made with openssl", () => {
    const body =
      '{"event_id":"evt_01test","event_type":"subscription.updated"}';
    expect(
      signPaddleWebhook(body, "pdl_ntfset_test_secret_value", 1_700_000_000),
    ).toBe(
      "ts=1700000000;h1=c6fe65a9372821b0003756a6bde3c26ddd5f5afc79b7610c76e67a950f12c965",
    );
  });

  // #436-T12
  it("is accepted by the verifier of the app", () => {
    const body = serializeEvent(first);
    const header = signPaddleWebhook(body, SECRET, NOW_SECONDS);
    expect(
      verifyPaddleSignature({
        header,
        rawBody: body,
        secret: SECRET,
        now: new Date(NOW_MS),
      }),
    ).toEqual({ ok: true, timestamp: NOW_SECONDS });
  });

  // #436-T12
  it("makes an event with the top level fields of a Paddle notification", () => {
    expect(first).toEqual({
      event_id: "evt_01fake0001",
      event_type: "subscription.updated",
      occurred_at: "2026-10-17T11:00:00.000Z",
      notification_id: expect.stringMatching(/^ntf_[a-z0-9]+$/),
      data: { id: "sub_01fake0001", status: "active" },
    });
    const generated = makeEvent("price.created", {});
    expect(generated.event_id).toMatch(/^evt_[a-z0-9]+$/);
    expect(generated.event_id).not.toBe(
      makeEvent("price.created", {}).event_id,
    );
    expect(new Date(generated.occurred_at).toISOString()).toBe(
      generated.occurred_at,
    );
  });
});

describe("buildDeliveries", () => {
  // #436-T12
  it("delivers each event once, in the order given, correctly signed", () => {
    const deliveries = buildDeliveries([first, second], {
      secret: SECRET,
      now,
    });
    expect(eventIds(deliveries)).toEqual(["evt_01fake0001", "evt_01fake0002"]);
    for (const delivery of deliveries) {
      expect(delivery.headers["content-type"]).toBe("application/json");
      expect(verdict(delivery).ok).toBe(true);
      expect(JSON.parse(delivery.body).event_id).toBe(delivery.eventId);
    }
  });

  // #436-T12
  it("repeats an event for a duplicate delivery, byte for byte", () => {
    const deliveries = buildDeliveries([first, second], {
      secret: SECRET,
      now,
      duplicates: 1,
    });
    expect(eventIds(deliveries)).toEqual([
      "evt_01fake0001",
      "evt_01fake0001",
      "evt_01fake0002",
      "evt_01fake0002",
    ]);
    expect(deliveries[1]?.body).toBe(deliveries[0]?.body);
    expect(verdict(deliveries[1] as PaddleDelivery).ok).toBe(true);
  });

  // #436-T12
  it("sends the newer event first for a reordered delivery", () => {
    const deliveries = buildDeliveries([first, second], {
      secret: SECRET,
      now,
      order: "reversed",
    });
    expect(eventIds(deliveries)).toEqual(["evt_01fake0002", "evt_01fake0001"]);
    expect(verdict(deliveries[0] as PaddleDelivery).ok).toBe(true);
  });

  // #436-T12
  it("signs with an old ts for a stale delivery: valid signature, refused by age", () => {
    const [delivery] = buildDeliveries([first], {
      secret: SECRET,
      now,
      fault: "stale_timestamp",
      staleSeconds: 3600,
    });
    expect(delivery?.headers["paddle-signature"]).toContain(
      `ts=${NOW_SECONDS - 3600};`,
    );
    expect(verdict(delivery as PaddleDelivery)).toEqual({
      ok: false,
      code: "timestamp_out_of_tolerance",
    });
  });

  // #436-T12
  it("signs with another secret for a bad signature", () => {
    const [delivery] = buildDeliveries([first], {
      secret: SECRET,
      now,
      fault: "bad_signature",
    });
    expect(verdict(delivery as PaddleDelivery)).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #436-T12
  it("puts two h1 values in the header, the valid one first or last", () => {
    for (const fault of ["two_h1_valid_first", "two_h1_valid_last"] as const) {
      const [delivery] = buildDeliveries([first], {
        secret: SECRET,
        now,
        fault,
      });
      const header = delivery?.headers["paddle-signature"] ?? "";
      expect(header.match(/h1=/g)).toHaveLength(2);
      expect(verdict(delivery as PaddleDelivery).ok).toBe(true);
    }
    const [validFirst] = buildDeliveries([first], {
      secret: SECRET,
      now,
      fault: "two_h1_valid_first",
    });
    const [validLast] = buildDeliveries([first], {
      secret: SECRET,
      now,
      fault: "two_h1_valid_last",
    });
    expect(validFirst?.headers["paddle-signature"]).not.toBe(
      validLast?.headers["paddle-signature"],
    );
  });

  // #436-T12
  it("sends a different body than the one signed for an altered body", () => {
    const [honest] = buildDeliveries([first], { secret: SECRET, now });
    const [delivery] = buildDeliveries([first], {
      secret: SECRET,
      now,
      fault: "altered_body",
    });
    expect(delivery?.body).not.toBe(honest?.body);
    expect(() => JSON.parse(delivery?.body ?? "")).not.toThrow();
    expect(verdict(delivery as PaddleDelivery)).toEqual({
      ok: false,
      code: "signature_mismatch",
    });
  });

  // #436-T12
  it("leaves the header out or garbles it for a missing or malformed signature", () => {
    const [missing] = buildDeliveries([first], {
      secret: SECRET,
      now,
      fault: "missing_signature",
    });
    expect(missing?.headers).not.toHaveProperty("paddle-signature");
    expect(verdict(missing as PaddleDelivery)).toEqual({
      ok: false,
      code: "signature_missing",
    });
    const [malformed] = buildDeliveries([first], {
      secret: SECRET,
      now,
      fault: "malformed_signature",
    });
    expect(verdict(malformed as PaddleDelivery)).toEqual({
      ok: false,
      code: "signature_malformed",
    });
  });
});

describe("deliver", () => {
  // #436-T12
  it("posts the planned requests one after the other and returns what came back", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const results = await deliver(
      "http://127.0.0.1:1/api/billing/webhook",
      [first, second],
      {
        secret: SECRET,
        now,
        duplicates: 1,
        order: "reversed",
        fetch: async (url, init) => {
          seen.push({ url, init });
          return new Response(null, { status: seen.length === 2 ? 500 : 200 });
        },
      },
    );
    expect(seen.map((call) => call.url)).toEqual(
      Array(4).fill("http://127.0.0.1:1/api/billing/webhook"),
    );
    expect(seen.every((call) => call.init.method === "POST")).toBe(true);
    expect(results.map((result) => result.eventId)).toEqual([
      "evt_01fake0002",
      "evt_01fake0002",
      "evt_01fake0001",
      "evt_01fake0001",
    ]);
    expect(results.map((result) => result.status)).toEqual([
      200, 500, 200, 200,
    ]);
    expect(seen[0]?.init.body).toBe(
      buildDeliveries([first, second], {
        secret: SECRET,
        now,
        order: "reversed",
      })[0]?.body,
    );
  });
});
