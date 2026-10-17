// SPDX-License-Identifier: Apache-2.0

// A fake Paddle Billing API (loopback only, in memory) for the tests of the billing module of epic #421. It
// answers the endpoints the app's client uses (products, prices, transactions, subscriptions, customer portal
// sessions, notification settings) in Paddle's shapes: request bodies are validated against the documented
// fields, errors are `{ error: { type, code, detail } }` with 404, 409 and 429 (`Retry-After`), a price cannot be
// PATCHed in a field that sets what is charged (the same rule as the app's client), and faults can be scripted
// (faults.ts). Webhooks are the other direction: see webhooks.ts for the signer and the deliveries.
//
// The fake records every request, but never the key. What it does not know about Paddle (research S1 to S8 of
// epic #421) it does not pretend to know: see the options. Dummy values only; state is in memory.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { PaddleHttpError, errorBody } from "./errors.ts";
import { createFaults, type Faults } from "./faults.ts";
import { fakeId } from "./ids.ts";
import { createRoutes } from "./routes.ts";
import {
  createStore,
  type FakeEntity,
  type FakePrice,
  type FakeSubscription,
  type FakeTransaction,
} from "./store.ts";

export type PaddleFakeOptions = {
  /** The API key the fake accepts. Default: a dummy sandbox key. */
  apiKey?: string;
  /** One clock for the fake and the code under test. Default: the real clock. */
  now?: () => number;
  /** Copy the custom data of a paid transaction to the subscription. Default off (research S4: undocumented). */
  copyTransactionCustomData?: boolean;
};

export type FakePaddleRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  /** The JSON body; the text if it is not JSON; undefined when there is none. */
  body: unknown;
  /** Whether the bearer token was the fake's key. The key itself is never recorded. */
  authenticated: boolean;
};

export type FakePaddle = {
  /** What the client takes as its base URL: `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** The key the fake accepts. */
  apiKey: string;
  requests(): FakePaddleRequest[];
  faults: Faults;
  products(): FakeEntity[];
  prices(): FakePrice[];
  transactions(): FakeTransaction[];
  subscriptions(): FakeSubscription[];
  notificationSettings(): FakeEntity[];
  /** A live subscription to this (recurring) price, as if the customer had paid at Paddle's checkout. */
  seedSubscription(input: {
    priceId: string;
    customerId?: string;
    status?: "active" | "trialing" | "past_due" | "paused";
    /** The end of the current period; the period before it has the length of the price's cycle. */
    nextBilledAt?: string;
    customData?: Record<string, unknown> | null;
  }): FakeSubscription;
  /** The customer pays this transaction: it is completed and its recurring item starts a subscription. */
  payTransaction(
    transactionId: string,
    input?: { customerId?: string },
  ): FakeSubscription;
  /** No entities, no recorded requests, no faults. */
  reset(): void;
  close(): Promise<void>;
};

const DEFAULT_API_KEY = "pdl_sdbx_apikey_fake_key_for_tests";
const MAX_BODY_BYTES = 1_000_000;
const CHECKOUT_URL = "https://pay.example.test/billing/pay";

function sameKey(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startPaddleFake(
  options: PaddleFakeOptions = {},
): Promise<FakePaddle> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const now = options.now ?? Date.now;
  const store = createStore({
    now,
    checkoutUrl: CHECKOUT_URL,
    copyTransactionCustomData: options.copyTransactionCustomData ?? false,
  });
  const faults = createFaults();
  const routes = createRoutes(store, now);
  const recorded: FakePaddleRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let origin = "";

  function send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    if (res.destroyed || res.writableEnded) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const path = url.pathname;
    const requestId = fakeId("req");
    const text = await readBody(req);
    let body: unknown;
    if (text !== undefined && text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const authorization = req.headers.authorization ?? "";
    const authenticated =
      authorization.startsWith("Bearer ") &&
      sameKey(authorization.slice("Bearer ".length), apiKey);
    recorded.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      authenticated,
    });

    const fail = (
      status: number,
      code: string,
      detail: string,
      headers: Record<string, string> = {},
    ) => send(res, status, errorBody(status, code, detail, requestId), headers);

    if (text === undefined)
      return fail(413, "request_too_large", "The body is too large");
    if (!authenticated) {
      return authorization === ""
        ? fail(
            403,
            "authentication_missing",
            "Authentication header is missing",
          )
        : fail(403, "forbidden", "The key is not valid for this environment");
    }
    if (typeof body === "string")
      return fail(400, "invalid_request", "The body is not valid JSON");

    const fault = faults.take(method, path);
    if (fault?.kind === "status")
      return send(
        res,
        fault.status,
        fault.body ??
          errorBody(
            fault.status,
            fault.status >= 500 ? "internal_error" : "injected_fault",
            "Injected fault",
            requestId,
          ),
      );
    if (fault?.kind === "rate_limit")
      return fail(429, "too_many_requests", "Too many requests", {
        "retry-after": String(fault.retryAfterSeconds),
      });

    const candidates = routes.filter((route) => route.pattern.test(path));
    const route = candidates.find((candidate) => candidate.method === method);
    if (route === undefined)
      return candidates.length > 0
        ? fail(
            405,
            "method_not_allowed",
            `${method} is not allowed for ${path}`,
          )
        : fail(404, "not_found", `Route ${path} not found`);

    let answer: { status: number; payload: unknown };
    try {
      const params = (route.pattern.exec(path) ?? [])
        .slice(1)
        .map(decodeURIComponent);
      const reply = route.handler({
        query: url.searchParams,
        body,
        params,
        origin,
        path,
      });
      answer = {
        status: reply.status,
        payload: {
          data: structuredClone(reply.data),
          meta: {
            request_id: requestId,
            ...(reply.pagination === undefined
              ? {}
              : { pagination: reply.pagination }),
          },
        },
      };
    } catch (error) {
      if (!(error instanceof PaddleHttpError)) throw error;
      answer = {
        status: error.status,
        payload: errorBody(
          error.status,
          error.code,
          error.detail,
          requestId,
          error.fieldErrors,
        ),
      };
    }

    if (fault?.kind === "drop") {
      if (fault.mode === "reset") req.socket.destroy();
      // `hang`: the socket stays open and nothing is written; close() ends it.
      return;
    }
    if (fault?.kind === "delay") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        send(res, answer.status, answer.payload);
      }, fault.ms);
      timers.add(timer);
      return;
    }
    send(res, answer.status, answer.payload);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      send(
        res,
        500,
        errorBody(500, "internal_error", "The fake failed", "req_fake"),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl: origin,
    apiKey,
    requests: () => structuredClone(recorded),
    faults,
    products: () => structuredClone([...store.products.values()]),
    prices: () => structuredClone([...store.prices.values()]),
    transactions: () => structuredClone([...store.transactions.values()]),
    subscriptions: () => structuredClone([...store.subscriptions.values()]),
    notificationSettings: () =>
      structuredClone([...store.notificationSettings.values()]),
    seedSubscription: (input) =>
      structuredClone(
        store.addSubscription({
          priceId: input.priceId,
          customerId: input.customerId ?? fakeId("ctm"),
          status: input.status ?? "active",
          ...(input.nextBilledAt === undefined
            ? {}
            : { nextBilledAt: input.nextBilledAt }),
          customData: input.customData ?? null,
        }),
      ),
    payTransaction: (transactionId, input = {}) =>
      structuredClone(store.payTransaction(transactionId, input)),
    reset() {
      store.reset();
      faults.clear();
      recorded.length = 0;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
