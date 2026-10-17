// SPDX-License-Identifier: Apache-2.0

// A thin typed `fetch` client of the Paddle Billing API (ADR 0005, 2.10): the ten or so endpoints the billing
// module uses, our own schemas for the fields we read (paddle-schemas.ts), no SDK. The base URL is injected
// (sandbox, live, or the fake in fakes/paddle), so a test never needs the internet.
//
// - Every request has a time limit for all of it (connect, answer and body). No redirect is followed.
// - A 429 is retried after `Retry-After`, a bounded number of times and never for longer than a cap. Nothing else
//   is retried: Paddle has no idempotency keys, so after a timeout or a 5xx the caller must list before it
//   creates again (ADR 0005, 2.11).
// - Errors carry a stable code (`PADDLE_CLIENT_ERROR_CODES`), the HTTP status and Paddle's own error code. They
//   never carry a response body, a header or the API key; the caller's UI translates the code to copy.
// - Money guardrail (2.11): a price is never edited in a field that sets what is charged. `updatePrice` refuses
//   such a PATCH before it is sent.
import "server-only";
import type { z } from "zod";
import { parseRetryAfter, type DispatchFetch } from "../dispatch/send.ts";
import {
  envelope,
  listEnvelope,
  paddleErrorSchema,
  paddleNotificationSettingSchema,
  paddlePortalSessionSchema,
  paddlePriceSchema,
  paddleProductSchema,
  paddleSubscriptionPreviewSchema,
  paddleSubscriptionSchema,
  paddleTransactionSchema,
  type PaddleNotificationSetting,
  type PaddlePortalSession,
  type PaddlePrice,
  type PaddleProduct,
  type PaddleSubscription,
  type PaddleSubscriptionPreview,
  type PaddleTransaction,
} from "./paddle-schemas.ts";

export type {
  PaddleNotificationSetting,
  PaddlePortalSession,
  PaddlePrice,
  PaddleProduct,
  PaddleSubscription,
  PaddleSubscriptionPreview,
  PaddleTransaction,
} from "./paddle-schemas.ts";

export const PADDLE_CLIENT_ERROR_CODES = [
  "invalid_configuration",
  "invalid_argument",
  "price_field_immutable",
  "timeout",
  "network_error",
  "rate_limited",
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rejected",
  "server_error",
  "invalid_response",
] as const;
export type PaddleClientErrorCode = (typeof PADDLE_CLIENT_ERROR_CODES)[number];

const MESSAGES: Record<PaddleClientErrorCode, string> = {
  invalid_configuration: "The Paddle client is not configured correctly",
  invalid_argument: "A Paddle request argument is not valid",
  price_field_immutable: "This Paddle price field is never changed by the app",
  timeout: "Paddle did not answer in time",
  network_error: "Paddle could not be reached",
  rate_limited: "Paddle is rate limiting the app",
  bad_request: "Paddle refused the request as invalid",
  unauthorized: "Paddle did not accept the credentials",
  forbidden: "Paddle refused the request for these credentials",
  not_found: "Paddle does not know this entity",
  conflict: "Paddle refused the request in the current state",
  rejected: "Paddle refused the request",
  server_error: "Paddle failed to process the request",
  invalid_response: "Paddle answered with something the app cannot read",
};

export class PaddleClientError extends Error {
  readonly code: PaddleClientErrorCode;
  /** The HTTP status; null when no answer was received or none was needed (a refusal before sending). */
  readonly status: number | null;
  /** Paddle's `error.code` when it is a plain identifier (`subscription_locked_renewal`), else null. */
  readonly paddleCode: string | null;
  /** Seconds Paddle asked to wait, for `rate_limited`. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: PaddleClientErrorCode,
    details: {
      status?: number;
      paddleCode?: string | null;
      retryAfterSeconds?: number | null;
      context?: string;
    } = {},
  ) {
    super(
      details.context === undefined
        ? MESSAGES[code]
        : `${MESSAGES[code]} (${details.context})`,
    );
    this.name = "PaddleClientError";
    this.code = code;
    this.status = details.status ?? null;
    this.paddleCode = details.paddleCode ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}

export type PaddleEnvironment = "sandbox" | "live";

const BASE_URLS: Record<PaddleEnvironment, string> = {
  sandbox: "https://sandbox-api.paddle.com",
  live: "https://api.paddle.com",
};

export function paddleBaseUrl(environment: PaddleEnvironment): string {
  return BASE_URLS[environment];
}

/** Which Paddle environment a key belongs to, from its prefix alone; null for anything else. */
export function paddleKeyEnvironment(apiKey: string): PaddleEnvironment | null {
  if (apiKey.includes("_sdbx")) return "sandbox";
  if (apiKey.startsWith("pdl_live_")) return "live";
  return null;
}

/** The price fields that decide what a customer is charged. The app never PATCHes them. */
export const PADDLE_IMMUTABLE_PRICE_FIELDS = [
  "unit_price",
  "unit_price_overrides",
  "billing_cycle",
  "trial_period",
  "tax_mode",
] as const;

const ALLOWED_PRICE_PATCH_FIELDS = new Set([
  "name",
  "description",
  "custom_data",
  "status",
]);

export type Interval = "day" | "week" | "month" | "year";
export type CreateProductInput = {
  name: string;
  tax_category: string;
  description?: string | null;
  image_url?: string | null;
  custom_data?: Record<string, unknown> | null;
};
export type ProductPatch = {
  name?: string;
  description?: string | null;
  custom_data?: Record<string, unknown> | null;
  status?: "active" | "archived";
};
export type CreatePriceInput = {
  product_id: string;
  description: string;
  unit_price: { amount: string; currency_code: string };
  name?: string | null;
  billing_cycle?: { interval: Interval; frequency: number } | null;
  trial_period?: { interval: Interval; frequency: number } | null;
  tax_mode?: "account_setting" | "external" | "internal" | "location";
  custom_data?: Record<string, unknown> | null;
};
/** The only fields of a price the app edits. Anything else is refused at run time as well. */
export type PricePatch = {
  name?: string | null;
  description?: string;
  custom_data?: Record<string, unknown> | null;
  status?: "archived";
};
export type ListQuery = {
  id?: string[];
  status?: Array<"active" | "archived">;
  type?: "standard" | "custom";
  after?: string;
  per_page?: number;
};
export type ListPricesQuery = ListQuery & {
  product_id?: string[];
  recurring?: boolean;
};
export type ListSubscriptionsQuery = {
  id?: string[];
  customer_id?: string[];
  price_id?: string[];
  status?: Array<PaddleSubscription["status"]>;
  after?: string;
  per_page?: number;
};
export type CreateTransactionInput = {
  items: Array<{ price_id: string; quantity: number }>;
  customer_id?: string;
  custom_data?: Record<string, unknown>;
};
export type SubscriptionPatch = {
  items?: Array<{ price_id: string; quantity: number }>;
  proration_billing_mode?:
    | "prorated_immediately"
    | "prorated_next_billing_period"
    | "full_immediately"
    | "full_next_billing_period"
    | "do_not_bill";
  on_payment_failure?: "prevent_change" | "apply_change";
  /** `null` removes a pending cancellation. */
  scheduled_change?: null;
  custom_data?: Record<string, unknown> | null;
};
export type CreateNotificationSettingInput = {
  description: string;
  destination: string;
  subscribed_events: string[];
  type?: "url";
  api_version?: number;
  traffic_source?: "platform" | "simulation" | "all";
  include_sensitive_fields?: boolean;
};

/** One page of a list. Pass `nextAfter` as `after` for the next page; null on the last page. */
export type PaddlePage<T> = { items: T[]; nextAfter: string | null };

export type PaddleClientOptions = {
  /** Server-only. Sent as the bearer token and used for nothing else; never logged, never in an error. */
  apiKey: string;
  /** `paddleBaseUrl(environment)`, or the address of the fake. */
  baseUrl: string;
  fetch?: DispatchFetch;
  /** The limit for one request, all of it. Default 10 seconds. */
  timeoutMs?: number;
  /** How many times a 429 is retried. Default 2 (three tries in all). */
  maxRateLimitRetries?: number;
  /** A `Retry-After` above this is not waited for: the call fails with `rate_limited` at once. Default 30. */
  maxRetryAfterSeconds?: number;
  /** Waits between tries. Tests pass a function that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type PaddleClient = ReturnType<typeof createPaddleClient>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30;
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const MAX_RESPONSE_CHARS = 2_000_000;
const ID = /^[A-Za-z0-9_]{1,64}$/;
const PLAIN_CODE = /^[a-z][a-z0-9_]{0,63}$/;

type Method = "GET" | "POST" | "PATCH";
type Query = Record<string, string | number | boolean | string[] | undefined>;

function statusCode(status: number): PaddleClientErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "rejected";
}

function id(value: string): string {
  if (!ID.test(value)) throw new PaddleClientError("invalid_argument");
  return value;
}

function ids(values: string[] | undefined): string | undefined {
  return values === undefined ? undefined : values.map(id).join(",");
}

function assertPricePatchAllowed(patch: object): void {
  const keys = Reflect.ownKeys(patch);
  for (const key of keys) {
    if (typeof key !== "string" || !ALLOWED_PRICE_PATCH_FIELDS.has(key))
      throw new PaddleClientError("price_field_immutable");
  }
  const { status } = patch as { status?: unknown };
  if ("status" in patch && status !== "archived")
    throw new PaddleClientError("price_field_immutable");
}

export function createPaddleClient(options: PaddleClientOptions) {
  const { apiKey } = options;
  let origin: string;
  try {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("protocol");
    origin = url.origin;
  } catch {
    throw new PaddleClientError("invalid_configuration");
  }
  if (apiKey === "") throw new PaddleClientError("invalid_configuration");

  const doFetch: DispatchFetch =
    options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
  const maxRetryAfter =
    options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());

  function urlFor(path: string, query: Query | undefined): string {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(
        key,
        Array.isArray(value) ? value.join(",") : String(value),
      );
    }
    return url.toString();
  }

  /** One try: the parsed JSON of a 2xx, or a thrown `PaddleClientError`. */
  async function attempt(
    method: Method,
    path: string,
    query: Query | undefined,
    body: unknown,
  ): Promise<{ json: unknown } | { retryAfterSeconds: number | null }> {
    const context = `${method} ${path}`;
    const signal = AbortSignal.timeout(timeoutMs);
    let status: number;
    let text: string;
    let retryAfterHeader: string | null;
    try {
      const response = await doFetch(urlFor(path, query), {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        cache: "no-store",
        signal,
      });
      status = response.status;
      retryAfterHeader = response.headers.get("retry-after");
      text = await response.text();
    } catch {
      // The reason is dropped: a connection error may quote the address or a header.
      throw new PaddleClientError(
        signal.aborted ? "timeout" : "network_error",
        {
          context,
        },
      );
    }
    if (status === 429)
      return {
        retryAfterSeconds: parseRetryAfter(retryAfterHeader, now()),
      };
    if (status < 200 || status >= 300)
      throw new PaddleClientError(statusCode(status), {
        status,
        paddleCode: paddleCodeOf(text),
        context,
      });
    if (text.length > MAX_RESPONSE_CHARS)
      throw new PaddleClientError("invalid_response", { status, context });
    try {
      return { json: JSON.parse(text) as unknown };
    } catch {
      throw new PaddleClientError("invalid_response", { status, context });
    }
  }

  async function request<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    input: { query?: Query; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const context = `${method} ${path}`;
    for (let tries = 0; ; tries += 1) {
      const result = await attempt(method, path, input.query, input.body);
      if ("json" in result) {
        const parsed = schema.safeParse(result.json);
        if (!parsed.success)
          throw new PaddleClientError("invalid_response", { context });
        return parsed.data;
      }
      const wait = result.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
      if (tries >= maxRetries || wait > maxRetryAfter)
        throw new PaddleClientError("rate_limited", {
          status: 429,
          retryAfterSeconds: result.retryAfterSeconds,
          context,
        });
      await sleep(wait * 1000);
    }
  }

  async function one<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    input: { query?: Query; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    return (await request(method, path, envelope(schema), input)).data;
  }

  async function page<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Query,
  ): Promise<PaddlePage<z.infer<S>>> {
    const answer = await request("GET", path, listEnvelope(schema), { query });
    const { next, has_more } = answer.meta.pagination;
    return { items: answer.data, nextAfter: has_more ? afterOf(next) : null };
  }

  return asyncMethods({
    createProduct: (input: CreateProductInput): Promise<PaddleProduct> =>
      one("POST", "/products", paddleProductSchema, { body: input }),
    getProduct: (productId: string): Promise<PaddleProduct> =>
      one("GET", `/products/${id(productId)}`, paddleProductSchema),
    listProducts: (query: ListQuery = {}): Promise<PaddlePage<PaddleProduct>> =>
      page("/products", paddleProductSchema, {
        ...query,
        id: ids(query.id),
        status: query.status,
      }),
    updateProduct: (
      productId: string,
      patch: ProductPatch,
    ): Promise<PaddleProduct> =>
      one("PATCH", `/products/${id(productId)}`, paddleProductSchema, {
        body: patch,
      }),

    createPrice: (input: CreatePriceInput): Promise<PaddlePrice> =>
      one("POST", "/prices", paddlePriceSchema, { body: input }),
    getPrice: (priceId: string): Promise<PaddlePrice> =>
      one("GET", `/prices/${id(priceId)}`, paddlePriceSchema),
    listPrices: (
      query: ListPricesQuery = {},
    ): Promise<PaddlePage<PaddlePrice>> =>
      page("/prices", paddlePriceSchema, {
        ...query,
        id: ids(query.id),
        product_id: ids(query.product_id),
      }),
    /** Refuses, before anything is sent, a PATCH of a field that sets what is charged (`price_field_immutable`). */
    updatePrice(priceId: string, patch: PricePatch): Promise<PaddlePrice> {
      return Promise.resolve().then(() => {
        assertPricePatchAllowed(patch);
        return one("PATCH", `/prices/${id(priceId)}`, paddlePriceSchema, {
          body: patch,
        });
      });
    },

    createTransaction: (
      input: CreateTransactionInput,
    ): Promise<PaddleTransaction> =>
      one("POST", "/transactions", paddleTransactionSchema, { body: input }),

    getSubscription: (subscriptionId: string): Promise<PaddleSubscription> =>
      one(
        "GET",
        `/subscriptions/${id(subscriptionId)}`,
        paddleSubscriptionSchema,
      ),
    listSubscriptions: (
      query: ListSubscriptionsQuery = {},
    ): Promise<PaddlePage<PaddleSubscription>> =>
      page("/subscriptions", paddleSubscriptionSchema, {
        ...query,
        id: ids(query.id),
        customer_id: ids(query.customer_id),
        price_id: ids(query.price_id),
      }),
    updateSubscription: (
      subscriptionId: string,
      patch: SubscriptionPatch,
    ): Promise<PaddleSubscription> =>
      one(
        "PATCH",
        `/subscriptions/${id(subscriptionId)}`,
        paddleSubscriptionSchema,
        {
          body: patch,
        },
      ),
    /** What `updateSubscription` with this patch would do and cost; changes nothing. */
    previewSubscriptionUpdate: (
      subscriptionId: string,
      patch: SubscriptionPatch,
    ): Promise<PaddleSubscriptionPreview> =>
      one(
        "PATCH",
        `/subscriptions/${id(subscriptionId)}/preview`,
        paddleSubscriptionPreviewSchema,
        { body: patch },
      ),
    cancelSubscription: (
      subscriptionId: string,
      options: { effective_from?: "immediately" | "next_billing_period" } = {},
    ): Promise<PaddleSubscription> =>
      one(
        "POST",
        `/subscriptions/${id(subscriptionId)}/cancel`,
        paddleSubscriptionSchema,
        {
          body: options,
        },
      ),

    /** A new session each time: the links are short-lived, so they are never stored. */
    createPortalSession: (
      customerId: string,
      options: { subscription_ids?: string[] } = {},
    ): Promise<PaddlePortalSession> =>
      one(
        "POST",
        `/customers/${id(customerId)}/portal-sessions`,
        paddlePortalSessionSchema,
        {
          body: {
            ...(options.subscription_ids === undefined
              ? {}
              : { subscription_ids: options.subscription_ids.map(id) }),
          },
        },
      ),

    createNotificationSetting: (
      input: CreateNotificationSettingInput,
    ): Promise<PaddleNotificationSetting> =>
      one("POST", "/notification-settings", paddleNotificationSettingSchema, {
        body: { type: "url", ...input },
      }),
    getNotificationSetting: (
      settingId: string,
    ): Promise<PaddleNotificationSetting> =>
      one(
        "GET",
        `/notification-settings/${id(settingId)}`,
        paddleNotificationSettingSchema,
      ),
  });
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

/** Paddle's `error.code` of an error body, when the body is Paddle's shape and the code is a plain identifier. */
function paddleCodeOf(text: string): string | null {
  try {
    const parsed = paddleErrorSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const { code } = parsed.data.error;
    return PLAIN_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** The `after` cursor of the `next` URL of a list answer. */
function afterOf(next: string | null | undefined): string | null {
  if (next === null || next === undefined || next === "") return null;
  try {
    return new URL(next).searchParams.get("after");
  } catch {
    return null;
  }
}
