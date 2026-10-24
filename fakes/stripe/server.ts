// SPDX-License-Identifier: LicenseRef-Proprietary

// A fake Stripe API (loopback only, in memory) for the tests of the billing module of epic #489. It answers the endpoints
// the app's client uses (customers with tax ids, Checkout sessions, payment intents, charges, refunds, webhook endpoints,
// the account) in Stripe's shapes (fixtures in fakes/fixtures/stripe/), keeps `Idempotency-Key` semantics (the same key and
// parameters: the saved answer; the same key and other parameters: the idempotency error), refuses what Managed Payments
// does not support on a one-time Checkout (routes.ts), and can be made to have bad days (faults.ts).
//
// Webhooks are the other direction: the buyer helper (`buyer.pay`) and "Stripe" (`stripe.refund`, `stripe.openDispute`, ...)
// make events, and `flush` delivers them, signed with the `Stripe-Signature` scheme, to the webhook endpoints the app
// created through the API, with duplicates, another order, a delay or a faulty signature (webhooks.ts).
//
// The fake records every request, but never the key. Dummy values only; state is in memory; ids are the same every run.
// Started by a test through `startStripeFake`, or as a process of its own (main.ts) controlled over HTTP under `/__fake/`.
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { StripeHttpError, type StripeErrorBody } from "./errors.ts";
import { createFaults, type Faults, type RawAnswer } from "./faults.ts";
import { canonicalize, parseForm } from "./form.ts";
import { isLoopbackHostname, isLoopbackUrl } from "./loopback.ts";
import { createRoutes } from "./routes.ts";
import {
  NO_REQUEST,
  createStore,
  type EventCause,
  type FakeObject,
  type StripeEvent,
} from "./store.ts";
import { planDelivery, type DeliveryFault } from "./webhooks.ts";

export type { StripeEvent, FakeObject } from "./store.ts";
export {
  DELIVERY_FAULTS,
  signStripeWebhook,
  type DeliveryFault,
} from "./webhooks.ts";

export type StripeFakeOptions = {
  /** The API key the fake accepts. Default: a dummy test key. */
  apiKey?: string;
  /** One clock for the fake and the code under test, in milliseconds. Default: the real clock. */
  now?: () => number;
  /** How a delivery waits (`flush({ delayMs })`). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** A fixed port, for an app under test that has to know it when it starts. Default: any free port. */
  port?: number;
  /** Where to listen. Only a loopback address is accepted (the fake never opens a port to a network). Default: 127.0.0.1. */
  host?: string;
};

export type RecordedRequest = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  /** The form body, nested; strings are the only leaves. Empty when there is none. */
  form: Record<string, unknown>;
  headers: {
    stripeVersion: string | null;
    idempotencyKey: string | null;
    contentType: string | null;
  };
  /** Whether the bearer token was the fake's key. The key itself is never recorded. */
  authenticated: boolean;
  /** The status the fake answered or, for a lost answer, would have. */
  status: number;
  /** Whether the answer is a saved one, replayed for a repeated idempotency key. */
  replayed: boolean;
};

export type DeliveryOptions = {
  /** `reversed` sends the events last to first: the newest event arrives before the older ones. */
  order?: "given" | "reversed";
  /** Copies sent right after each event, byte for byte the same (Stripe delivers at least once). */
  duplicates?: number;
  /** Applied to every delivery. Without it every delivery is valid. */
  fault?: DeliveryFault;
  /** Milliseconds to wait before each delivery. */
  delayMs?: number;
  /** How old the `t` of a `stale_timestamp` delivery is. Default: one hour. */
  staleSeconds?: number;
  /** Send exactly these events, also when they were delivered before (a resend). Default: the events not yet taken. */
  eventIds?: string[];
};

export type DeliveryResult = {
  eventId: string;
  type: string;
  endpointId: string;
  /** The status the receiver answered; null when it could not be reached. */
  status: number | null;
  /** Set when the fake did not even try: the endpoint is not on the loopback, and no event leaves this machine. */
  refused?: "not_loopback";
  /** How often this event was sent to this endpoint, this send included. */
  attempt: number;
};

export type PaidSession = {
  session: FakeObject;
  paymentIntent: FakeObject;
  charge: FakeObject;
};

export type StripeFake = {
  /** What the client takes as its base URL: `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** The key the fake accepts. */
  apiKey: string;
  requests(): RecordedRequest[];
  faults: Faults;
  customers(): FakeObject[];
  checkoutSessions(): FakeObject[];
  paymentIntents(): FakeObject[];
  charges(): FakeObject[];
  invoices(): FakeObject[];
  refunds(): FakeObject[];
  disputes(): FakeObject[];
  webhookEndpoints(): FakeObject[];
  events(): StripeEvent[];
  /** The signing secret of a webhook endpoint, which the API shows only in the answer to the create. */
  secretOf(endpointId: string): string | undefined;
  /** Stripe forgets an idempotency key after 24 hours: the same key with the same parameters then runs again. */
  forgetIdempotencyKeys(): void;
  /** Stripe deletes a customer when the buyer asks for their data to go. */
  deleteCustomer(customerId: string): void;
  /** The buyer at Stripe's page. */
  buyer: {
    /** Pays an open session: completes it, makes the payment intent and the charge, and their events. */
    pay(
      sessionId: string,
      options?: {
        /** Tax added on top of the net amount, in cents. */
        taxAmount?: number;
        /** A discount taken off the subtotal, in cents. */
        discountAmount?: number;
        /** What the buyer's card is charged when it is not the session's amount and currency (Adaptive Pricing). */
        charged?: { currency: string; amount: number };
      },
    ): PaidSession;
    /** A delayed payment that fails after the buyer has left. */
    failAsync(sessionId: string): {
      session: FakeObject;
      paymentIntent: FakeObject;
    };
  };
  /** Things Stripe does on its own or the operator does in the dashboard: no API request of the app is behind them. */
  stripe: {
    refund(input: {
      charge?: string;
      paymentIntent?: string;
      amount?: number;
      reason?: string;
    }): { refund: FakeObject; charge: FakeObject };
    failRefund(refundId: string): { refund: FakeObject; charge: FakeObject };
    openDispute(
      chargeId: string,
      options?: { amount?: number; reason?: string },
    ): { dispute: FakeObject; charge: FakeObject };
    closeDispute(disputeId: string, outcome: "won" | "lost"): FakeObject;
    /** An invoice Stripe made on its own (a draft, an open one, a voided one). */
    addInvoice(patch: Record<string, unknown>): FakeObject;
    /** A bad day: the list of invoices answers every customer's invoices whatever `customer` it was asked for. */
    ignoreInvoiceCustomerFilter(ignored?: boolean): void;
  };
  /** Sends the events that no endpoint has taken yet to the endpoints that subscribed to them. */
  flush(options?: DeliveryOptions): Promise<DeliveryResult[]>;
  /** No objects, no events, no recorded requests, no faults. */
  reset(): void;
  close(): Promise<void>;
};

const DEFAULT_API_KEY = "sk_test_FakeKeyForTests0000000000";
const MAX_BODY_BYTES = 1_000_000;
const DELIVERY_TIMEOUT_MS = 5000;

function sameKey(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Answer = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  raw?: RawAnswer;
};

const errorAnswer = (
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): Answer => ({
  status,
  body: { error: { type, message } } satisfies StripeErrorBody,
  headers,
});

export async function startStripeFake(
  options: StripeFakeOptions = {},
): Promise<StripeFake> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHostname(host))
    throw new Error(
      `The fake Stripe API listens on the loopback only, not on ${host}.`,
    );
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const store = createStore({ now });
  const faults = createFaults();
  const routes = createRoutes();
  const recorded: RecordedRequest[] = [];
  /** Saved answers by idempotency key: what the first request with it answered, and what it asked. */
  const saved = new Map<string, { fingerprint: string; answer: Answer }>();
  /** Idempotency keys of requests that ran but whose answer is still on its way (a `delay`): a second one is a 409. */
  const inFlight = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  let origin = "";

  function send(
    response: ServerResponse,
    answer: Answer,
    requestId: string,
  ): void {
    if (response.destroyed || response.writableEnded) return;
    if (answer.raw !== undefined) {
      const raw = answer.raw;
      response.writeHead(raw.status, {
        "content-type": raw.contentType ?? "application/json",
        ...raw.headers,
      });
      response.end(raw.body ?? "");
      return;
    }
    const text = JSON.stringify(answer.body);
    response.writeHead(answer.status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      "request-id": requestId,
      ...answer.headers,
    });
    response.end(text);
  }

  function execute(
    method: string,
    path: string,
    query: Record<string, unknown>,
    form: Record<string, unknown>,
    cause: EventCause,
  ): Answer {
    const candidates = routes.filter((route) => route.pattern.test(path));
    const route = candidates.find((candidate) => candidate.method === method);
    if (route === undefined)
      return candidates.length > 0
        ? errorAnswer(
            405,
            "invalid_request_error",
            `${method} is not allowed for ${path}`,
          )
        : errorAnswer(
            404,
            "invalid_request_error",
            `Unrecognized request URL (${method}: ${path}).`,
          );
    try {
      const params = (route.pattern.exec(path) ?? []).slice(1);
      const reply = route.handler({
        params,
        query,
        form,
        origin,
        cause,
        store,
      });
      return { status: reply.status, body: structuredClone(reply.body) };
    } catch (error) {
      if (!(error instanceof StripeHttpError)) throw error;
      return { status: error.status, body: error.body };
    }
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const path = url.pathname;
    if (path.startsWith("/__fake/"))
      return control(request, response, method, path);

    const requestId = store.ids.next("req");
    const text = await readBody(request);
    const query = parseForm(url.searchParams.toString());
    const idempotencyKey = request.headers["idempotency-key"];
    const record: RecordedRequest = {
      method,
      path,
      query,
      form: {},
      headers: {
        stripeVersion: stringHeader(request.headers["stripe-version"]),
        idempotencyKey: stringHeader(idempotencyKey),
        contentType: stringHeader(request.headers["content-type"]),
      },
      authenticated: false,
      status: 0,
      replayed: false,
    };
    recorded.push(record);
    const finish = (answer: Answer) => {
      record.status = answer.raw?.status ?? answer.status;
      send(response, answer, requestId);
    };
    const version = record.headers.stripeVersion;
    const withVersion = (answer: Answer): Answer => ({
      ...answer,
      headers: {
        ...(version === null ? {} : { "stripe-version": version }),
        ...answer.headers,
      },
    });

    if (text === undefined)
      return finish(
        errorAnswer(
          413,
          "invalid_request_error",
          "The request body is too large.",
        ),
      );
    const authorization = request.headers.authorization ?? "";
    record.authenticated =
      authorization.startsWith("Bearer ") &&
      sameKey(authorization.slice("Bearer ".length), apiKey);
    if (!record.authenticated)
      return finish(
        errorAnswer(
          401,
          "invalid_request_error",
          authorization === ""
            ? "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY')."
            : "Invalid API Key provided.",
        ),
      );

    const fault = faults.take(method, path);
    if (fault?.kind === "status")
      return finish(
        withVersion({
          status: fault.status,
          body:
            fault.body ??
            ({
              error: {
                type:
                  fault.status >= 500 ? "api_error" : "invalid_request_error",
                message: "Injected fault",
              },
            } satisfies StripeErrorBody),
          headers: fault.status >= 500 ? { "stripe-should-retry": "true" } : {},
        }),
      );
    if (fault?.kind === "rate_limit")
      return finish(
        withVersion(
          errorAnswer(
            429,
            "rate_limit_error",
            "Too many requests hit the API too quickly.",
            {
              "retry-after": String(fault.retryAfterSeconds),
            },
          ),
        ),
      );
    if (fault?.kind === "raw")
      return finish({
        status: fault.answer.status,
        body: null,
        raw: fault.answer,
      });

    let form: Record<string, unknown>;
    try {
      form = text === "" ? {} : parseForm(text);
    } catch (error) {
      if (!(error instanceof StripeHttpError)) throw error;
      return finish(withVersion({ status: error.status, body: error.body }));
    }
    record.form = form;

    let answer: Answer;
    const key = typeof idempotencyKey === "string" ? idempotencyKey : undefined;
    const fingerprint = `${method} ${path} ${canonicalize(form)}`;
    const earlier =
      method === "POST" && key !== undefined ? saved.get(key) : undefined;
    if (method === "POST" && key !== undefined && inFlight.has(key)) {
      // Stripe: a request with a key that another request is still using is refused, and the refusal is not saved.
      answer = {
        status: 409,
        body: {
          error: {
            type: "invalid_request_error",
            code: "idempotency_key_in_use",
            message: `There is currently another in-progress request using this Stripe idempotency key (that probably means you submitted twice, and the other request is still going through). Please try again later.`,
          },
        } satisfies StripeErrorBody,
        headers: {},
      };
    } else if (earlier !== undefined && earlier.fingerprint !== fingerprint) {
      answer = errorAnswer(
        400,
        "idempotency_error",
        `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
      );
    } else if (earlier !== undefined) {
      record.replayed = true;
      answer = {
        ...earlier.answer,
        headers: { ...earlier.answer.headers, "idempotent-replayed": "true" },
      };
    } else {
      const cause: EventCause = { requestId, idempotencyKey: key ?? null };
      answer = execute(method, path, query, form, cause);
      // Only an answer of a request that ran is saved: a refusal of its parameters is not, as at Stripe.
      if (
        method === "POST" &&
        key !== undefined &&
        answer.status >= 200 &&
        answer.status < 300
      )
        saved.set(key, { fingerprint, answer });
    }
    answer = withVersion({
      ...answer,
      headers: {
        ...(key === undefined ? {} : { "idempotency-key": key }),
        ...answer.headers,
      },
    });

    if (fault?.kind === "drop") {
      record.status = answer.status;
      if (fault.mode === "reset") request.socket.destroy();
      // `hang`: the socket stays open and nothing is written; close() ends it.
      return;
    }
    if (fault?.kind === "delay") {
      record.status = answer.status;
      const held =
        method === "POST" &&
        key !== undefined &&
        !record.replayed &&
        answer.status >= 200 &&
        answer.status < 300;
      if (held) inFlight.add(key);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (held) inFlight.delete(key);
        send(response, answer, requestId);
      }, fault.ms);
      timers.add(timer);
      return;
    }
    finish(answer);
  }

  // --- delivery

  async function flush(
    delivery: DeliveryOptions = {},
  ): Promise<DeliveryResult[]> {
    const chosen = delivery.eventIds;
    const pending = store.events.filter((event) => {
      if (chosen !== undefined) return chosen.includes(event.id);
      return [...store.maps.endpoints.values()].some(
        (endpoint) =>
          store.subscribed(endpoint, event.type) &&
          store.deliveries.get(`${event.id}|${endpoint.id}`)?.delivered !==
            true,
      );
    });
    const ordered =
      delivery.order === "reversed" ? [...pending].reverse() : pending;
    const results: DeliveryResult[] = [];
    for (const event of ordered) {
      // Stripe's body is JSON with two spaces of indentation; the signature covers exactly these bytes.
      const body = JSON.stringify(event, null, 2);
      for (const endpoint of store.maps.endpoints.values()) {
        const target = endpoint as FakeObject & {
          url: string;
          enabled_events: string[];
          status: "enabled" | "disabled";
        };
        if (!store.subscribed(target, event.type)) continue;
        const key = `${event.id}|${endpoint.id}`;
        if (
          chosen === undefined &&
          store.deliveries.get(key)?.delivered === true
        )
          continue;
        // "No real network" is structural: an endpoint that is not on this machine gets nothing, whatever a test says.
        if (!isLoopbackUrl(target.url)) {
          results.push({
            eventId: event.id,
            type: event.type,
            endpointId: endpoint.id,
            status: null,
            refused: "not_loopback",
            attempt: store.deliveries.get(key)?.attempts ?? 0,
          });
          continue;
        }
        const secret = store.secretOf(endpoint.id) ?? "";
        for (let copy = 0; copy <= (delivery.duplicates ?? 0); copy += 1) {
          if (delivery.delayMs !== undefined && delivery.delayMs > 0)
            await sleep(delivery.delayMs);
          const planned = planDelivery({
            body,
            secret,
            seconds: Math.floor(now() / 1000),
            fault: delivery.fault,
            staleSeconds: delivery.staleSeconds,
          });
          const state = store.deliveries.get(key) ?? {
            attempts: 0,
            delivered: false,
          };
          state.attempts += 1;
          store.deliveries.set(key, state);
          let status: number | null = null;
          try {
            const sent = await fetch(target.url, {
              method: "POST",
              headers: {
                "content-type": "application/json; charset=utf-8",
                "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
                "cache-control": "no-cache",
                ...(planned.signature === undefined
                  ? {}
                  : { "stripe-signature": planned.signature }),
              },
              body: planned.body,
              redirect: "manual",
              signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
            });
            status = sent.status;
            void sent.body?.cancel().catch(() => undefined);
          } catch {
            status = null;
          }
          if (status !== null && status >= 200 && status < 300)
            state.delivered = true;
          results.push({
            eventId: event.id,
            type: event.type,
            endpointId: endpoint.id,
            status,
            attempt: state.attempts,
          });
        }
      }
    }
    return results;
  }

  // --- the control API of the fake as a process of its own

  async function control(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(text);
    };
    if (path === "/__fake/health" && method === "GET")
      return reply(200, { ok: true });
    if (path === "/__fake/events" && method === "GET")
      return reply(200, { data: store.events });
    if (method !== "POST")
      return reply(404, { error: "unknown control route" });
    const text = (await readBody(request)) ?? "";
    let body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a control request of a journey, read field by field
    try {
      body = text === "" ? {} : (JSON.parse(text) as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any -- as above
    } catch {
      return reply(400, { error: "not JSON" });
    }
    try {
      switch (path) {
        case "/__fake/pay": {
          const paid = api.buyer.pay(body.session, {
            ...(body.tax_amount === undefined
              ? {}
              : { taxAmount: body.tax_amount }),
            ...(body.discount_amount === undefined
              ? {}
              : { discountAmount: body.discount_amount }),
            ...(body.charged === undefined ? {} : { charged: body.charged }),
          });
          return reply(200, {
            session: paid.session.id,
            payment_intent: paid.paymentIntent.id,
            charge: paid.charge.id,
          });
        }
        case "/__fake/refund": {
          const done = api.stripe.refund({
            ...(body.charge === undefined ? {} : { charge: body.charge }),
            ...(body.payment_intent === undefined
              ? {}
              : { paymentIntent: body.payment_intent }),
            ...(body.amount === undefined ? {} : { amount: body.amount }),
          });
          return reply(200, { refund: done.refund.id, charge: done.charge.id });
        }
        case "/__fake/dispute": {
          const opened = api.stripe.openDispute(body.charge, {
            ...(body.amount === undefined ? {} : { amount: body.amount }),
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          });
          return reply(200, { dispute: opened.dispute.id });
        }
        case "/__fake/dispute/close":
          return reply(200, {
            status: api.stripe.closeDispute(body.dispute, body.outcome).status,
          });
        case "/__fake/flush":
          return reply(200, {
            data: await flush({
              ...(body.order === undefined ? {} : { order: body.order }),
              ...(body.duplicates === undefined
                ? {}
                : { duplicates: body.duplicates }),
              ...(body.fault === undefined ? {} : { fault: body.fault }),
              ...(body.delay_ms === undefined
                ? {}
                : { delayMs: body.delay_ms }),
              ...(body.event_ids === undefined
                ? {}
                : { eventIds: body.event_ids }),
            }),
          });
        case "/__fake/reset":
          api.reset();
          return reply(200, { ok: true });
        default:
          return reply(404, { error: "unknown control route" });
      }
    } catch (error) {
      if (error instanceof StripeHttpError) return reply(400, error.body);
      throw error;
    }
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) return response.destroy();
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { type: "api_error", message: "The fake failed." },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, host, resolve),
  );
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${(server.address() as AddressInfo).port}`;

  const values = (map: Map<string, FakeObject>) =>
    structuredClone([...map.values()]);
  const api: StripeFake = {
    baseUrl: origin,
    apiKey,
    requests: () => structuredClone(recorded),
    faults,
    customers: () => values(store.maps.customers),
    checkoutSessions: () => values(store.maps.sessions),
    paymentIntents: () => values(store.maps.paymentIntents),
    charges: () => values(store.maps.charges),
    invoices: () => values(store.maps.invoices),
    refunds: () => values(store.maps.refunds),
    disputes: () => values(store.maps.disputes),
    webhookEndpoints: () => values(store.maps.endpoints),
    events: () => structuredClone(store.events),
    secretOf: (endpointId) => store.secretOf(endpointId),
    deleteCustomer: (customerId) =>
      store.deleteCustomer(customerId, NO_REQUEST),
    buyer: {
      pay: (sessionId, payOptions) =>
        structuredClone(store.pay(sessionId, payOptions)),
      failAsync: (sessionId) => structuredClone(store.failAsync(sessionId)),
    },
    stripe: {
      refund: (input) => structuredClone(store.refund(input, NO_REQUEST)),
      failRefund: (refundId) =>
        structuredClone(store.failRefund(refundId, NO_REQUEST)),
      openDispute: (chargeId, disputeOptions) =>
        structuredClone(store.openDispute(chargeId, disputeOptions)),
      closeDispute: (disputeId, outcome) =>
        structuredClone(store.closeDispute(disputeId, outcome)),
      addInvoice: (patch) => structuredClone(store.addInvoice(patch)),
      ignoreInvoiceCustomerFilter: (ignored = true) =>
        store.ignoreInvoiceCustomerFilter(ignored),
    },
    forgetIdempotencyKeys: () => saved.clear(),
    flush,
    reset() {
      store.reset();
      faults.clear();
      saved.clear();
      inFlight.clear();
      recorded.length = 0;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}

function stringHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}
