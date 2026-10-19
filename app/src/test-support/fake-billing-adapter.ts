// SPDX-License-Identifier: Apache-2.0

// A billing adapter for tests (#497): a made-up provider whose "wire" is a small JSON body signed with HMAC-SHA256 in the
// header `x-fake-signature`, so the webhook route, the application of events and the adapter kit run without a real
// provider or a network. It reads and refuses exactly the way a real adapter must: the signature over the exact bytes
// first, the body only afterwards, a code and nothing else on refusal. `fakeWebhookRequest` builds what its provider
// would send. The same shape is the model of the Stripe adapter's tests (#502).
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  TOP_UP_MAX_MICRO_USD,
  TOP_UP_MIN_MICRO_USD,
  type BillingAdapter,
  type BillingEvent,
  type TopUpLookupEvent,
  type Usd,
  type WebhookResult,
} from "../billing/adapter.ts";

export const FAKE_ADAPTER_ID = "fake";
export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-for-tests";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

/** The fake provider's body: our normalized event with the type under `kind` and a few renamed fields. */
export type FakeWireEvent =
  | {
      id: string;
      kind: "payment";
      created: string;
      intent?: string | null;
      payment: string;
      checkout?: string | null;
      net: number;
      gross: number;
      tax?: number | null;
    }
  | {
      id: string;
      kind: "payment_failed";
      created: string;
      intent?: string | null;
      payment?: string | null;
      checkout?: string | null;
    }
  | {
      id: string;
      kind: "refund";
      created: string;
      payment: string;
      refund: string;
      amount: number;
      /** The whole payment, in the same unit as `amount`. */
      payment_amount: number;
      by?: "seller" | "provider" | "customer";
      status: "pending" | "approved" | "rejected" | "reversed";
    }
  | {
      id: string;
      kind: "dispute";
      created: string;
      payment: string;
      dispute: string;
      amount: number;
      payment_amount: number;
      status: "opened" | "lost" | "won";
    }
  | {
      id: string;
      kind: "payment_expired";
      created: string;
      intent?: string | null;
      payment?: string | null;
      checkout?: string | null;
    }
  | { id: string; kind: "other"; created: string };

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/** The bytes of a body as a provider sends them. */
export function fakeBodyBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The text of a body, for a test that wants to look at it; throws on bytes that are not UTF-8. */
export function fakeBodyText(bytes: Uint8Array): string {
  return strictDecoder.decode(bytes);
}

export function signFakeBody(
  rawBody: string | Uint8Array,
  secret = FAKE_WEBHOOK_SECRET,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function fakeWebhookRequest(
  wire: FakeWireEvent | string | Uint8Array,
  secret = FAKE_WEBHOOK_SECRET,
): { headers: Headers; rawBody: Uint8Array } {
  const rawBody =
    wire instanceof Uint8Array
      ? wire
      : fakeBodyBytes(typeof wire === "string" ? wire : JSON.stringify(wire));
  return {
    rawBody,
    headers: new Headers({
      [FAKE_SIGNATURE_HEADER]: signFakeBody(rawBody, secret),
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLookupEvent(event: BillingEvent): event is TopUpLookupEvent {
  return (
    event.type === "payment.succeeded" ||
    event.type === "payment.failed" ||
    event.type === "payment.expired"
  );
}

/** Maps the fake wire body to our event. Returns undefined for a body that is not one. */
function toEvent(value: unknown): BillingEvent | undefined {
  if (!isRecord(value)) return undefined;
  const wire = value as Record<string, never>;
  const common = {
    eventId: wire.id as string,
    occurredAt: wire.created as string,
  };
  switch (wire.kind as string) {
    case "payment":
      return {
        ...common,
        type: "payment.succeeded",
        intentId: (wire.intent ?? null) as string | null,
        payment: wire.payment,
        checkout: (wire.checkout ?? null) as string | null,
        creditable: wire.net as Usd,
        gross: wire.gross as Usd,
        tax: (wire.tax ?? null) as Usd | null,
      };
    case "payment_failed":
      return {
        ...common,
        type: "payment.failed",
        intentId: (wire.intent ?? null) as string | null,
        payment: (wire.payment ?? null) as string | null,
        checkout: (wire.checkout ?? null) as string | null,
      };
    case "refund":
      return {
        ...common,
        type: "refund.updated",
        payment: wire.payment,
        refund: wire.refund,
        amount: wire.amount,
        paymentAmount: wire.payment_amount,
        initiatedBy: (wire.by ?? "provider") as
          "seller" | "provider" | "customer",
        status: wire.status,
      };
    case "dispute":
      return {
        ...common,
        type: "dispute.updated",
        payment: wire.payment,
        dispute: wire.dispute,
        amount: wire.amount,
        paymentAmount: wire.payment_amount,
        status: wire.status,
      };
    case "payment_expired":
      return {
        ...common,
        type: "payment.expired",
        intentId: (wire.intent ?? null) as string | null,
        payment: (wire.payment ?? null) as string | null,
        checkout: (wire.checkout ?? null) as string | null,
      };
    case "other":
      return { ...common, type: "ignored" };
    default:
      return undefined;
  }
}

export function createFakeBillingAdapter(
  options: {
    secret?: string;
    id?: string;
    /** What the fake provider answers when asked about a top-up, by intent id (`lookupTopUp`). */
    lookups?: (intentId: string) => FakeWireEvent | undefined;
  } = {},
): BillingAdapter {
  const secret = options.secret ?? FAKE_WEBHOOK_SECRET;
  return {
    id: options.id ?? FAKE_ADAPTER_ID,
    capabilities: {
      merchantOfRecord: false,
      customAmount: true,
      partialRefund: true,
      minTopUp: TOP_UP_MIN_MICRO_USD,
      maxTopUp: TOP_UP_MAX_MICRO_USD,
      currencies: ["usd"],
      providerMayRefund: { windowDays: 30 },
      requiresBillingProfile: false,
      receiptsFrom: "provider",
    },
    ensureCustomer: ({ workspace }) =>
      Promise.resolve(`cus_fake_${workspace.id}`),
    createTopUpCheckout: ({ intentId }) =>
      Promise.resolve({
        checkout: {
          kind: "redirect",
          url: `https://pay.fake.test/c/${intentId}`,
        },
        session: `cs_fake_${intentId}`,
        payment: null,
      }),
    lookupTopUp: ({ intentId }) => {
      const wire = options.lookups?.(intentId);
      const event = wire === undefined ? undefined : toEvent(wire);
      return Promise.resolve(
        event !== undefined && isLookupEvent(event) ? event : null,
      );
    },
    verifyAndParseWebhook({ headers, rawBody }): Promise<WebhookResult> {
      const given = headers.get(FAKE_SIGNATURE_HEADER);
      if (given === null || given === "")
        return Promise.resolve({ ok: false, code: "signature_missing" });
      const expected = Buffer.from(signFakeBody(rawBody, secret), "hex");
      const actual = Buffer.from(given, "hex");
      // Constant time, and only over equal lengths (timingSafeEqual throws otherwise).
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return Promise.resolve({ ok: false, code: "signature_invalid" });

      let parsed: unknown;
      try {
        parsed = JSON.parse(fakeBodyText(rawBody));
      } catch {
        return Promise.resolve({ ok: false, code: "body_invalid" });
      }
      const event = toEvent(parsed);
      return Promise.resolve(
        event === undefined
          ? { ok: false, code: "body_invalid" }
          : { ok: true, event },
      );
    },
  };
}
