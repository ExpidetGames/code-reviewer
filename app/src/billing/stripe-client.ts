// SPDX-License-Identifier: Apache-2.0

// A thin typed `fetch` client of the Stripe API (ADR 0006, 2.13; #500): the dozen endpoints the billing module uses, our
// own schemas for the fields we read (stripe-schemas.ts), no SDK (few endpoints, easier to fake, no dependency; the same
// reasoning as ADR 0005, 2.10). The base URL is injected (Stripe's one address, or the fake in fakes/stripe), so a test
// never needs the internet. Docs: https://docs.stripe.com/api and https://docs.stripe.com/payments/managed-payments.
//
// - Requests are form-encoded, as Stripe wants them. `Stripe-Version` is pinned (`2025-03-31.basil`, plus the Managed
//   Payments preview flag by default), so a change at Stripe cannot change what we read.
// - Every POST carries an `Idempotency-Key`: the caller's, or a fresh one made for the call and kept over its retries.
//   That is what makes a POST safe to try again after a lost answer or a 5xx. A GET and a DELETE are idempotent by nature.
// - A 429 is retried after `Retry-After`, a bounded number of times and never for longer than a cap. A 5xx, a lost
//   connection and a timeout are retried with a growing wait, unless Stripe says `Stripe-Should-Retry: false`. Nothing
//   else is retried.
// - Every request has a time limit for all of it (connect, answer and body). No redirect is followed. A body is read in
//   chunks and dropped once it passes `MAX_RESPONSE_BYTES`, so the limit bounds memory.
// - Errors carry a stable code (`STRIPE_CLIENT_ERROR_CODES`), the HTTP status and Stripe's own `type` and `code` when
//   they are plain identifiers. They never carry a response body, a header or the API key, and the client logs nothing.
// - The environment of the key (`sk_test_`/`rk_test_` or `sk_live_`/`rk_live_`) must fit the configured environment on
//   Stripe's address (which is the same for both, so the environment is the caller's statement); any other address (the
//   fake) takes any key.
import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { parseRetryAfter, type DispatchFetch } from "../dispatch/send.ts";
import {
  stripeAccountSchema,
  stripeChargeSchema,
  stripeCheckoutSessionSchema,
  stripeCustomerSchema,
  stripeDeletedSchema,
  stripeErrorSchema,
  stripeListSchema,
  stripePaymentIntentSchema,
  stripeRefundSchema,
  stripeTaxIdSchema,
  stripeWebhookEndpointSchema,
  type StripeAccount,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeCustomer,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeTaxId,
  type StripeWebhookEndpoint,
} from "./stripe-schemas.ts";

export type {
  StripeAccount,
  StripeCharge,
  StripeCheckoutSession,
  StripeCustomer,
  StripePaymentIntent,
  StripeRefund,
  StripeTaxId,
  StripeWebhookEndpoint,
} from "./stripe-schemas.ts";

/** Stripe's address, the same for the test and the live environment (the key decides which one is meant). */
export const STRIPE_API_BASE_URL = "https://api.stripe.com";
/** The API version every request pins: `2025-03-31.basil` or later is what Managed Payments needs. */
export const STRIPE_API_VERSION = "2025-03-31.basil";
/** The same version with the preview flag of Managed Payments (the merchant of record), the header Checkout needs. */
export const STRIPE_MANAGED_PAYMENTS_API_VERSION = `${STRIPE_API_VERSION}; managed_payments_preview=v1`;

export const STRIPE_CLIENT_ERROR_CODES = [
  "invalid_configuration",
  "environment_mismatch",
  "invalid_argument",
  "timeout",
  "network_error",
  "rate_limited",
  "bad_request",
  "idempotency_conflict",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rejected",
  "server_error",
  "invalid_response",
  "response_too_large",
  "redirect_refused",
] as const;
export type StripeClientErrorCode = (typeof STRIPE_CLIENT_ERROR_CODES)[number];

const MESSAGES: Record<StripeClientErrorCode, string> = {
  invalid_configuration: "The Stripe client is not configured correctly",
  environment_mismatch:
    "The Stripe API key belongs to another environment than the configured one",
  invalid_argument: "A Stripe request argument is not valid",
  timeout: "Stripe did not answer in time",
  network_error: "Stripe could not be reached",
  rate_limited: "Stripe is rate limiting the app",
  bad_request: "Stripe refused the request as invalid",
  idempotency_conflict:
    "Stripe refused the request: its idempotency key was used for other parameters",
  unauthorized: "Stripe did not accept the credentials",
  forbidden: "Stripe refused the request for these credentials",
  not_found: "Stripe does not know this object",
  conflict: "Stripe refused the request in the current state",
  rejected: "Stripe refused the request",
  server_error: "Stripe failed to process the request",
  invalid_response: "Stripe answered with something the app cannot read",
  response_too_large: "Stripe answered with more data than the app accepts",
  redirect_refused:
    "Stripe answered with a redirect, which the app never follows",
};

export class StripeClientError extends Error {
  readonly code: StripeClientErrorCode;
  /** The HTTP status; null when no answer was received or none was needed (a refusal before sending). */
  readonly status: number | null;
  /** Stripe's `error.code` (`resource_missing`) when it is a plain identifier, else null. */
  readonly stripeCode: string | null;
  /** Stripe's `error.type` (`invalid_request_error`) when it is a plain identifier, else null. */
  readonly stripeType: string | null;
  /** Seconds Stripe asked to wait, for `rate_limited`. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: StripeClientErrorCode,
    details: {
      status?: number;
      stripeCode?: string | null;
      stripeType?: string | null;
      retryAfterSeconds?: number | null;
      context?: string;
    } = {},
  ) {
    super(
      details.context === undefined
        ? MESSAGES[code]
        : `${MESSAGES[code]} (${details.context})`,
    );
    this.name = "StripeClientError";
    this.code = code;
    this.status = details.status ?? null;
    this.stripeCode = details.stripeCode ?? null;
    this.stripeType = details.stripeType ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}

export type StripeEnvironment = "test" | "live";

/** Which environment a key belongs to, from its prefix alone; null for anything else (a publishable key, a typo). */
export function stripeKeyEnvironment(apiKey: string): StripeEnvironment | null {
  if (apiKey.startsWith("sk_test_") || apiKey.startsWith("rk_test_"))
    return "test";
  if (apiKey.startsWith("sk_live_") || apiKey.startsWith("rk_live_"))
    return "live";
  return null;
}

type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
};
export type CreateCustomerInput = {
  name?: string;
  /** The business the customer is, next to `name` (probed against the sandbox on 2026-10-21, API version 2025-03-31.basil). */
  business_name?: string;
  email?: string;
  description?: string;
  address?: Address;
  preferred_locales?: string[];
  /** The VAT or business ids to attach when the customer is created, for example `{ type: "eu_vat", value: "DE..." }`. */
  tax_id_data?: Array<{ type: string; value: string }>;
  metadata?: Record<string, string>;
};
/** What can change on a customer. `null` clears a field (a metadata key set to `null` is removed). */
export type CustomerPatch = {
  name?: string | null;
  business_name?: string | null;
  email?: string | null;
  description?: string | null;
  address?: Address | null;
  preferred_locales?: string[];
  metadata?: Record<string, string | null>;
};
/**
 * A one-time Checkout session of Managed Payments. The fields Managed Payments does not support
 * (`tax_id_collection`, `invoice_creation`, `customer_update`, `payment_method_types`, `custom_text`, ...) are not in
 * this type on purpose, so none can be sent by accident.
 */
export type CreateCheckoutSessionInput = {
  mode: "payment";
  line_items: Array<{
    quantity: number;
    price_data: {
      currency: string;
      /** In cents. */
      unit_amount: number;
      tax_behavior?: "exclusive" | "inclusive" | "unspecified";
      product_data: {
        name: string;
        description?: string;
        /** Managed Payments needs an eligible product tax code. */
        tax_code?: string;
      };
    };
  }>;
  success_url: string;
  cancel_url: string;
  customer?: string;
  client_reference_id?: string;
  metadata?: Record<string, string>;
  managed_payments?: { enabled: boolean };
  expires_at?: number;
  locale?: string;
};
export type CreateRefundInput = {
  /** Exactly one of `payment_intent` and `charge`. */
  payment_intent?: string;
  charge?: string;
  /** In cents; the whole payment when left out. */
  amount?: number;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
  metadata?: Record<string, string>;
};
export type CreateWebhookEndpointInput = {
  url: string;
  enabled_events: string[];
  description?: string;
  /** The API version the events are rendered in; the account's default when left out. */
  api_version?: string;
  metadata?: Record<string, string>;
};
/** For a call that creates something at Stripe: the key that makes it safe to repeat. */
export type WriteOptions = { idempotencyKey?: string };
/**
 * For a call that moves money (a Checkout session, a refund): the key is not optional. A key generated per call would be
 * new for every call of ours, so a repeat after a crash or a lost answer would charge or refund a second time; the
 * caller derives the key from what it is doing (the top-up intent, the refund request).
 */
export type MoneyWriteOptions = { idempotencyKey: string };

export type StripeClientOptions = {
  /** Server-only. Sent as the bearer token and used for nothing else; never logged, never in an error. */
  apiKey: string;
  /** `STRIPE_API_BASE_URL`, or the address of the fake. There is no default: the client reaches no host it was not given. */
  baseUrl: string;
  /** What the instance is configured for. Required on Stripe's address, where the key's prefix must fit it. */
  environment?: StripeEnvironment;
  /** Send the Managed Payments preview flag with the API version. Default true. */
  managedPayments?: boolean;
  fetch?: DispatchFetch;
  /** The limit for one request, all of it. Default 10 seconds. */
  timeoutMs?: number;
  /** How many times a call is tried again after a 429, a 5xx, a lost connection or a timeout. Default 2. */
  maxRetries?: number;
  /** A `Retry-After` above this is not waited for: the call fails with `rate_limited` at once. Default 30. */
  maxRetryAfterSeconds?: number;
  /** Waits between tries. Tests pass a function that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** The key of a POST that was given none. Default a random UUID. */
  newIdempotencyKey?: () => string;
};

export type StripeClient = ReturnType<typeof createStripeClient>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30;
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const BACKOFF_BASE_MS = 500;
const MAX_RESPONSE_BYTES = 2_000_000;
/** The most pages `listWebhookEndpoints` follows: a list longer than this is refused, not cut. */
const MAX_LIST_PAGES = 20;
const LIST_PAGE_SIZE = 100;
const ID = /^[A-Za-z0-9_]{1,255}$/;
const PLAIN_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
const FORM_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e][\x20-\x7e]{0,254}$/;

type Method = "GET" | "POST" | "DELETE";
type Query = Array<[string, string]>;

function id(value: string): string {
  if (!ID.test(value)) throw new StripeClientError("invalid_argument");
  return value;
}

/**
 * The body as Stripe wants it: `a[b]=c` for an object, `a[0]=c` for a list, `true`/`false` for a boolean, and an empty
 * value for `null` (which clears a field). `undefined` is left out. The keys come from our own types, but a metadata key
 * is free text: one that could break out of the brackets is refused, and values are percent-encoded by the encoder.
 */
export function formEntries(
  value: Record<string, unknown>,
  prefix = "",
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const add = (name: string, item: unknown): void => {
    if (item === undefined) return;
    if (item === null) entries.push([name, ""]);
    else if (Array.isArray(item))
      item.forEach((element, index) => add(`${name}[${index}]`, element));
    else if (typeof item === "object")
      entries.push(...formEntries(item as Record<string, unknown>, name));
    else if (typeof item === "string") entries.push([name, item]);
    else if (typeof item === "number" && Number.isFinite(item))
      entries.push([name, String(item)]);
    else if (typeof item === "boolean") entries.push([name, String(item)]);
    else throw new StripeClientError("invalid_argument");
  };
  for (const [key, item] of Object.entries(value)) {
    if (!FORM_KEY.test(key)) throw new StripeClientError("invalid_argument");
    add(prefix === "" ? key : `${prefix}[${key}]`, item);
  }
  return entries;
}

/**
 * The body as text, or null when it passes `MAX_RESPONSE_BYTES`. Stops reading at the limit and cancels the stream; a
 * declared `content-length` above the limit is refused without reading. A read that does not end is cut by `signal`.
 */
async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const giveUp = async () => {
    await reader.cancel().catch(() => undefined);
    return null;
  };
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    return giveUp();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await untilAborted(reader.read(), signal).catch(
      async (error: unknown) => {
        await reader.cancel().catch(() => undefined);
        throw error;
      },
    );
    if (done) return Buffer.concat(chunks).toString("utf8");
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) return giveUp();
    chunks.push(value);
  }
}

/** The promise, or a rejection when the signal fires first: a request or a body that stalls must not outlive the limit. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function statusCode(
  status: number,
  stripeType: string | null,
): StripeClientErrorCode {
  if (stripeType === "idempotency_error") return "idempotency_conflict";
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "rejected";
}

/** `error.type` and `error.code` of an error body, each only when it is a plain identifier. */
function errorIdentifiers(text: string | null): {
  stripeCode: string | null;
  stripeType: string | null;
} {
  const none = { stripeCode: null, stripeType: null };
  if (text === null) return none;
  try {
    const parsed = stripeErrorSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return none;
    const { code, type } = parsed.data.error;
    return {
      stripeCode:
        code !== undefined && PLAIN_IDENTIFIER.test(code) ? code : null,
      stripeType:
        type !== undefined && PLAIN_IDENTIFIER.test(type) ? type : null,
    };
  } catch {
    return none;
  }
}

/** What one try came to: the parsed JSON of a 2xx, or a reason to try again (the error to throw if there is no next try). */
type Attempt =
  | { kind: "ok"; json: unknown }
  | {
      kind: "retry";
      /** 429 is retried for any call; the others only when the call is safe to repeat. */
      rateLimited: boolean;
      waitSeconds: number | null;
      error: StripeClientError;
      shouldRetry: boolean;
    };

/**
 * The host as the URL parser reads it (lowercase, percent-escapes decoded, IPv4 forms normalised), without the trailing
 * dots that name the same host in DNS: `api.stripe.com.` and `api.stripe.com%2e` are Stripe's host, spelled differently.
 */
function normalisedHostname(url: URL): string {
  return url.hostname.replace(/\.+$/, "");
}

/** Stripe's own hosts: `stripe.com` and everything below it. */
function isStripeHost(hostname: string): boolean {
  return hostname === "stripe.com" || hostname.endsWith(".stripe.com");
}

/** The loopback of this machine, where the fake runs; the only place a key may travel without TLS. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export function createStripeClient(options: StripeClientOptions) {
  const { apiKey } = options;
  let origin: string;
  let hostname: string;
  try {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("protocol");
    origin = url.origin;
    hostname = normalisedHostname(url);
    // The key is a bearer token: it travels over TLS, or to a process on this very machine.
    if (url.protocol === "http:" && !isLoopbackHost(hostname))
      throw new Error("plain http");
  } catch {
    throw new StripeClientError("invalid_configuration");
  }
  if (apiKey === "") throw new StripeClientError("invalid_configuration");
  // On a Stripe host (however it is spelled) the key's prefix must fit the configured environment (a live key under a test
  // setting would charge real cards); Stripe itself would only accept the key. Only a host that is not Stripe's (the fake
  // on the loopback, a stub under test) takes any key.
  if (isStripeHost(hostname)) {
    if (options.environment === undefined)
      throw new StripeClientError("invalid_configuration");
    if (stripeKeyEnvironment(apiKey) !== options.environment)
      throw new StripeClientError("environment_mismatch");
  }

  const doFetch: DispatchFetch =
    options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryAfter =
    options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const newKey = options.newIdempotencyKey ?? (() => randomUUID());
  const version =
    options.managedPayments === false
      ? STRIPE_API_VERSION
      : STRIPE_MANAGED_PAYMENTS_API_VERSION;

  function urlFor(path: string, query: Query): string {
    const url = new URL(path, origin);
    for (const [key, value] of query) url.searchParams.append(key, value);
    return url.toString();
  }

  /** One try. A thrown `StripeClientError` ends the call; an `Attempt` of kind `retry` may be tried again. */
  async function attempt(
    method: Method,
    path: string,
    query: Query,
    body: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<Attempt> {
    const context = `${method} ${path}`;
    const signal = AbortSignal.timeout(timeoutMs);
    let status: number;
    let text: string | null;
    let retryAfterHeader: string | null;
    let shouldRetryHeader: string | null;
    try {
      const response = await untilAborted(
        doFetch(urlFor(path, query), {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "stripe-version": version,
            accept: "application/json",
            ...(body === undefined
              ? {}
              : { "content-type": "application/x-www-form-urlencoded" }),
            ...(idempotencyKey === undefined
              ? {}
              : { "idempotency-key": idempotencyKey }),
          },
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          cache: "no-store",
          signal,
        }),
        signal,
      );
      status = response.status;
      retryAfterHeader = response.headers.get("retry-after");
      shouldRetryHeader = response.headers.get("stripe-should-retry");
      if (status >= 300 && status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new StripeClientError("redirect_refused", { status, context });
      }
      text = await readBody(response, signal);
    } catch (error) {
      if (error instanceof StripeClientError) throw error;
      // The reason is dropped: a connection error may quote the address or a header.
      return {
        kind: "retry",
        rateLimited: false,
        waitSeconds: null,
        shouldRetry: true,
        error: new StripeClientError(
          signal.aborted ? "timeout" : "network_error",
          { context },
        ),
      };
    }
    if (text === null && (status < 200 || status >= 300))
      throw new StripeClientError("response_too_large", { status, context });
    if (status === 429) {
      const retryAfterSeconds = parseRetryAfter(retryAfterHeader, now());
      return {
        kind: "retry",
        rateLimited: true,
        waitSeconds: retryAfterSeconds,
        shouldRetry: true,
        error: new StripeClientError("rate_limited", {
          status,
          retryAfterSeconds,
          ...errorIdentifiers(text),
          context,
        }),
      };
    }
    if (status >= 500) {
      return {
        kind: "retry",
        rateLimited: false,
        waitSeconds: null,
        shouldRetry: shouldRetryHeader !== "false",
        error: new StripeClientError("server_error", {
          status,
          ...errorIdentifiers(text),
          context,
        }),
      };
    }
    if (status < 200 || status >= 300) {
      const identifiers = errorIdentifiers(text);
      throw new StripeClientError(statusCode(status, identifiers.stripeType), {
        status,
        ...identifiers,
        context,
      });
    }
    if (text === null)
      throw new StripeClientError("response_too_large", { status, context });
    try {
      return { kind: "ok", json: JSON.parse(text) as unknown };
    } catch {
      throw new StripeClientError("invalid_response", { status, context });
    }
  }

  async function request<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    input: {
      query?: Query;
      form?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {},
  ): Promise<z.infer<S>> {
    const context = `${method} ${path}`;
    const body =
      input.form === undefined
        ? undefined
        : new URLSearchParams(formEntries(input.form)).toString();
    // The same key for every try of this call: that is what lets Stripe answer a repeated POST with the first answer.
    let idempotencyKey: string | undefined;
    if (method === "POST") {
      idempotencyKey = input.idempotencyKey ?? newKey();
      if (!IDEMPOTENCY_KEY.test(idempotencyKey))
        throw new StripeClientError("invalid_argument");
    }
    const mayRepeat = method !== "POST" || idempotencyKey !== undefined;
    for (let tries = 0; ; tries += 1) {
      const result = await attempt(
        method,
        path,
        input.query ?? [],
        body,
        idempotencyKey,
      );
      if (result.kind === "ok") {
        const parsed = schema.safeParse(result.json);
        if (!parsed.success)
          throw new StripeClientError("invalid_response", { context });
        return parsed.data;
      }
      const repeatable =
        result.rateLimited || (mayRepeat && result.shouldRetry);
      if (tries >= maxRetries || !repeatable) throw result.error;
      if (result.rateLimited) {
        const wait = result.waitSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
        if (wait > maxRetryAfter) throw result.error;
        await sleep(wait * 1000);
      } else {
        await sleep(BACKOFF_BASE_MS * 2 ** tries);
      }
    }
  }

  async function listAll<S extends z.ZodType>(
    path: string,
    schema: S,
  ): Promise<Array<z.infer<S>>> {
    const items: Array<z.infer<S>> = [];
    const listSchema = stripeListSchema(schema);
    let after: string | null = null;
    for (let pages = 0; pages < MAX_LIST_PAGES; pages += 1) {
      const query: Query = [["limit", String(LIST_PAGE_SIZE)]];
      if (after !== null) query.push(["starting_after", after]);
      const answer = (await request("GET", path, listSchema, { query })) as {
        data: Array<z.infer<S> & { id: string }>;
        has_more: boolean;
      };
      items.push(...answer.data);
      if (!answer.has_more) return items;
      const last = answer.data.at(-1);
      if (last === undefined)
        throw new StripeClientError("invalid_response", {
          context: `GET ${path}`,
        });
      after = last.id;
    }
    // A list that cannot be read to the end is refused: an endpoint of ours on a page not seen would be created twice.
    throw new StripeClientError("invalid_response", { context: `GET ${path}` });
  }

  return asyncMethods({
    createCustomer: (
      input: CreateCustomerInput,
      write: WriteOptions = {},
    ): Promise<StripeCustomer> =>
      request("POST", "/v1/customers", stripeCustomerSchema, {
        form: input,
        ...write,
      }),
    updateCustomer: (
      customerId: string,
      patch: CustomerPatch,
      write: WriteOptions = {},
    ): Promise<StripeCustomer> =>
      request("POST", `/v1/customers/${id(customerId)}`, stripeCustomerSchema, {
        form: patch,
        ...write,
      }).then(notDeleted),
    /** A customer that Stripe reports as deleted is `not_found`, like the 404 it may be. */
    getCustomer: (
      customerId: string,
      options: { expandTaxIds?: boolean } = {},
    ): Promise<StripeCustomer> =>
      request("GET", `/v1/customers/${id(customerId)}`, stripeCustomerSchema, {
        query: options.expandTaxIds === true ? [["expand[]", "tax_ids"]] : [],
      }).then(notDeleted),
    createCustomerTaxId: (
      customerId: string,
      input: { type: string; value: string },
      write: WriteOptions = {},
    ): Promise<StripeTaxId> =>
      request(
        "POST",
        `/v1/customers/${id(customerId)}/tax_ids`,
        stripeTaxIdSchema,
        { form: input, ...write },
      ),
    deleteCustomerTaxId: async (
      customerId: string,
      taxIdId: string,
    ): Promise<void> => {
      await request(
        "DELETE",
        `/v1/customers/${id(customerId)}/tax_ids/${id(taxIdId)}`,
        stripeDeletedSchema,
      );
    },

    createCheckoutSession: (
      input: CreateCheckoutSessionInput,
      write: MoneyWriteOptions,
    ): Promise<StripeCheckoutSession> =>
      request("POST", "/v1/checkout/sessions", stripeCheckoutSessionSchema, {
        form: input,
        ...write,
      }),
    getCheckoutSession: (sessionId: string): Promise<StripeCheckoutSession> =>
      request(
        "GET",
        `/v1/checkout/sessions/${id(sessionId)}`,
        stripeCheckoutSessionSchema,
      ),
    expireCheckoutSession: (
      sessionId: string,
      write: WriteOptions = {},
    ): Promise<StripeCheckoutSession> =>
      request(
        "POST",
        `/v1/checkout/sessions/${id(sessionId)}/expire`,
        stripeCheckoutSessionSchema,
        { form: {}, ...write },
      ),

    getPaymentIntent: (paymentIntentId: string): Promise<StripePaymentIntent> =>
      request(
        "GET",
        `/v1/payment_intents/${id(paymentIntentId)}`,
        stripePaymentIntentSchema,
      ),
    getCharge: (chargeId: string): Promise<StripeCharge> =>
      request("GET", `/v1/charges/${id(chargeId)}`, stripeChargeSchema),

    createRefund: (
      input: CreateRefundInput,
      write: MoneyWriteOptions,
    ): Promise<StripeRefund> => {
      // Stripe takes one of the two; both or neither is a mistake of the caller that must not cost a request.
      if ((input.payment_intent === undefined) === (input.charge === undefined))
        throw new StripeClientError("invalid_argument");
      return request("POST", "/v1/refunds", stripeRefundSchema, {
        form: input,
        ...write,
      });
    },
    getRefund: (refundId: string): Promise<StripeRefund> =>
      request("GET", `/v1/refunds/${id(refundId)}`, stripeRefundSchema),

    createWebhookEndpoint: (
      input: CreateWebhookEndpointInput,
      write: WriteOptions = {},
    ): Promise<StripeWebhookEndpoint> =>
      request("POST", "/v1/webhook_endpoints", stripeWebhookEndpointSchema, {
        form: input,
        ...write,
      }),
    /** Every endpoint of the account (without their secrets: Stripe shows a secret only when it creates one). */
    listWebhookEndpoints: (): Promise<StripeWebhookEndpoint[]> =>
      listAll("/v1/webhook_endpoints", stripeWebhookEndpointSchema),
    deleteWebhookEndpoint: async (endpointId: string): Promise<void> => {
      await request(
        "DELETE",
        `/v1/webhook_endpoints/${id(endpointId)}`,
        stripeDeletedSchema,
      );
    },

    /** The connection check: the account the key belongs to, and whether it can take payments. */
    getAccount: async (): Promise<StripeAccount> => {
      const account = await request("GET", "/v1/account", stripeAccountSchema);
      return {
        id: account.id,
        charges_enabled: account.charges_enabled,
        details_submitted: account.details_submitted,
        country: account.country,
        ...(account.default_currency === undefined
          ? {}
          : { default_currency: account.default_currency }),
      };
    },
  });
}

function notDeleted(customer: StripeCustomer): StripeCustomer {
  if (customer.deleted === true)
    throw new StripeClientError("not_found", { status: 200 });
  return customer;
}

/** Every method fails by rejecting, also when it refuses its arguments before building a request. */
function asyncMethods<
  M extends Record<string, (...args: never[]) => Promise<unknown>>,
>(methods: M): M {
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(methods))
    wrapped[name] = (...args: never[]) =>
      Promise.resolve().then(() => method(...args));
  return wrapped as M;
}
