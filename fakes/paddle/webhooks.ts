// SPDX-License-Identifier: Apache-2.0

// The webhook side of the fake Paddle: signs a body the way Paddle does, makes events in the shape of a
// notification and plans what Paddle's delivery would send to the app's webhook route (duplicate, reordered,
// stale, tampered), so the route tests of the billing epic (#421) can replay those cases.
//
// The signature scheme is written out again here on purpose and does not import the app's verifier
// (app/src/billing/webhook-verify.ts): a test that signs with one and verifies with the other proves that both
// follow Paddle's documented rule (`ts=<unix seconds>;h1=<hex>`, HMAC-SHA256 over `<ts>:<raw body>`).
import { createHmac } from "node:crypto";
import { fakeId } from "./ids.ts";

/** A notification as Paddle sends it: the top level fields and a snapshot of the entity in `data`. */
export type PaddleEvent = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: unknown;
};

/** `Paddle-Signature` for this body: `ts=<ts>;h1=<hex>`. `ts` is in unix seconds, now by default. */
export function signPaddleWebhook(
  rawBody: string,
  secret: string,
  ts: number = Math.floor(Date.now() / 1000),
): string {
  return `ts=${ts};h1=${h1(rawBody, secret, ts)}`;
}

function h1(rawBody: string, secret: string, ts: number): string {
  return createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
}

export function makeEvent(
  type: string,
  data: unknown,
  options: {
    /** RFC 3339 text or a date. Default: now. */
    occurredAt?: string | Date;
    eventId?: string;
    notificationId?: string;
  } = {},
): PaddleEvent {
  const occurredAt = options.occurredAt ?? new Date();
  return {
    event_id: options.eventId ?? fakeId("evt"),
    event_type: type,
    occurred_at:
      typeof occurredAt === "string" ? occurredAt : occurredAt.toISOString(),
    notification_id: options.notificationId ?? fakeId("ntf"),
    data,
  };
}

/** The raw body of a delivery. The app must verify these exact bytes. */
export function serializeEvent(event: PaddleEvent): string {
  return JSON.stringify(event);
}

export const DELIVERY_FAULTS = [
  "stale_timestamp",
  "bad_signature",
  "two_h1_valid_first",
  "two_h1_valid_last",
  "altered_body",
  "missing_signature",
  "malformed_signature",
] as const;
export type DeliveryFault = (typeof DELIVERY_FAULTS)[number];

export type DeliveryOptions = {
  /** The secret of the notification destination, `pdl_ntfset_...`. */
  secret: string;
  /** Milliseconds since the epoch; the clock of the signature. Default: the real clock. */
  now?: () => number;
  /** `reversed` sends the events last to first: the newest event arrives before the older ones. */
  order?: "given" | "reversed";
  /** Copies sent right after each event, byte for byte the same (Paddle delivers at least once). */
  duplicates?: number;
  /** Applied to every delivery. Without it every delivery is valid. */
  fault?: DeliveryFault;
  /** How old the `ts` of a `stale_timestamp` delivery is. Default: one hour. */
  staleSeconds?: number;
};

export type PaddleDelivery = {
  eventId: string;
  headers: Record<string, string>;
  body: string;
};

const WRONG_SECRET_SUFFIX = "-not-the-secret";

/** Replaces the id of the event: still JSON, a different message than the one that was signed. */
function alter(body: string): string {
  const altered = body.replace(/"event_id":"([^"]*)"/, '"event_id":"$1x"');
  return altered === body ? `${body} ` : altered;
}

function signatureHeader(
  body: string,
  sent: string,
  options: DeliveryOptions,
  seconds: number,
): string | undefined {
  const { secret, fault } = options;
  const wrongSecret = secret + WRONG_SECRET_SUFFIX;
  switch (fault) {
    case "stale_timestamp":
      return signPaddleWebhook(
        sent,
        secret,
        seconds - (options.staleSeconds ?? 3600),
      );
    case "bad_signature":
      return signPaddleWebhook(sent, wrongSecret, seconds);
    case "two_h1_valid_first":
      return `${signPaddleWebhook(sent, secret, seconds)};h1=${h1(sent, wrongSecret, seconds)}`;
    case "two_h1_valid_last":
      return `ts=${seconds};h1=${h1(sent, wrongSecret, seconds)};h1=${h1(sent, secret, seconds)}`;
    case "altered_body":
      // Signed over the original, sent with the altered text.
      return signPaddleWebhook(body, secret, seconds);
    case "missing_signature":
      return undefined;
    case "malformed_signature":
      return "ts=not-a-number;h1";
    case undefined:
      return signPaddleWebhook(sent, secret, seconds);
  }
}

/** What Paddle would send to the webhook route for these events, without sending it. */
export function buildDeliveries(
  events: PaddleEvent[],
  options: DeliveryOptions,
): PaddleDelivery[] {
  const seconds = Math.floor((options.now ?? Date.now)() / 1000);
  const ordered = options.order === "reversed" ? [...events].reverse() : events;
  const copies = 1 + (options.duplicates ?? 0);
  return ordered.flatMap((event) => {
    const body = serializeEvent(event);
    const sent = options.fault === "altered_body" ? alter(body) : body;
    const signature = signatureHeader(body, sent, options, seconds);
    const delivery: PaddleDelivery = {
      eventId: event.event_id,
      headers: {
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "paddle-signature": signature }),
      },
      body: sent,
    };
    return Array.from({ length: copies }, () => delivery);
  });
}

export type DeliveryResult = { eventId: string; status: number };

/** Posts the planned deliveries to `url` one after the other; each result is the status the app answered. */
export async function deliver(
  url: string,
  events: PaddleEvent[],
  options: DeliveryOptions & {
    /** Default: the global `fetch`. Tests may pass a recording function. */
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  },
): Promise<DeliveryResult[]> {
  const send = options.fetch ?? fetch;
  const results: DeliveryResult[] = [];
  for (const delivery of buildDeliveries(events, options)) {
    const response = await send(url, {
      method: "POST",
      headers: delivery.headers,
      body: delivery.body,
    });
    void response.body?.cancel().catch(() => undefined);
    results.push({ eventId: delivery.eventId, status: response.status });
  }
  return results;
}
