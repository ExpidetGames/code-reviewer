// SPDX-License-Identifier: Apache-2.0

// The endpoints of the fake Paddle: the ones the billing module uses (issue #436), with the request shapes of
// Paddle's documentation and the behavior the research of epic #421 records. A handler gets the parsed request
// and returns a status and a body, or throws a `PaddleHttpError`.
import { conflict, invalidFields } from "./errors.ts";
import {
  addCycle,
  stamp,
  type FakeEntity,
  type FakePrice,
  type FakeSubscription,
  type Store,
} from "./store.ts";
import {
  CYCLE,
  MONEY,
  array,
  boolean,
  integer,
  nullable,
  object,
  optional,
  parseBody,
  record,
  required,
  string,
  type Shape,
} from "./validate.ts";

export type RouteRequest = {
  query: URLSearchParams;
  body: unknown;
  params: string[];
  /** `http://127.0.0.1:<port>`, for the `next` link of a list. */
  origin: string;
  path: string;
};
export type RouteReply = {
  status: number;
  data: unknown;
  pagination?: Record<string, unknown>;
};
type Handler = (request: RouteRequest) => RouteReply;
type Route = { method: string; pattern: RegExp; handler: Handler };

const TAX_CATEGORIES = [
  "digital-goods",
  "ebooks",
  "implementation-services",
  "professional-services",
  "saas",
  "software-programming-services",
  "standard",
  "training-services",
  "website-hosting",
] as const;
const STATUSES = ["active", "archived"] as const;
const TAX_MODES = [
  "account_setting",
  "external",
  "internal",
  "location",
] as const;
const PRORATION_MODES = [
  "prorated_immediately",
  "prorated_next_billing_period",
  "full_immediately",
  "full_next_billing_period",
  "do_not_bill",
] as const;
const RENEWAL_LOCK_MS = 30 * 60_000;
const ID_FILTER = /^[A-Za-z0-9_,]+$/;

const items: Shape = {
  price_id: required(string({ pattern: /^pri_[a-z0-9]+$/ })),
  quantity: required(integer({ min: 1 })),
};

const PRODUCT_CREATE: Shape = {
  name: required(string({ min: 1, max: 200 })),
  tax_category: required(string({ oneOf: TAX_CATEGORIES })),
  description: optional(nullable(string({ max: 2048 }))),
  image_url: optional(nullable(string({ pattern: /^https?:\/\// }))),
  custom_data: optional(nullable(record)),
};
const PRODUCT_PATCH: Shape = {
  name: optional(string({ min: 1, max: 200 })),
  tax_category: optional(string({ oneOf: TAX_CATEGORIES })),
  description: optional(nullable(string({ max: 2048 }))),
  image_url: optional(nullable(string({ pattern: /^https?:\/\// }))),
  custom_data: optional(nullable(record)),
  status: optional(string({ oneOf: STATUSES })),
};
const UNIT_PRICE_OVERRIDES = array(
  object({
    country_codes: required(array(string({ pattern: /^[A-Z]{2}$/ }))),
    unit_price: required(object(MONEY)),
  }),
);
const PRICE_CREATE: Shape = {
  product_id: required(string({ pattern: /^pro_[a-z0-9]+$/ })),
  description: required(string({ min: 1, max: 500 })),
  unit_price: required(object(MONEY)),
  name: optional(nullable(string({ max: 200 }))),
  type: optional(string({ oneOf: ["standard", "custom"] })),
  billing_cycle: optional(nullable(object(CYCLE))),
  trial_period: optional(nullable(object(CYCLE))),
  tax_mode: optional(string({ oneOf: TAX_MODES })),
  unit_price_overrides: optional(UNIT_PRICE_OVERRIDES),
  quantity: optional(
    object({
      minimum: required(integer({ min: 1 })),
      maximum: required(integer({ min: 1 })),
    }),
  ),
  custom_data: optional(nullable(record)),
};
// The fields Paddle's PATCH accepts (research §1, verified), including the money fields. That Paddle locks them
// once a price is in use is undocumented (S1), so the fake accepts them. Refusing a PATCH of them is the app's own
// policy (`updatePrice` in app/src/billing, `price_field_immutable`) and lives in the client, in front of the fake.
const PRICE_PATCH: Shape = {
  unit_price: optional(object(MONEY)),
  unit_price_overrides: optional(UNIT_PRICE_OVERRIDES),
  billing_cycle: optional(nullable(object(CYCLE))),
  trial_period: optional(nullable(object(CYCLE))),
  tax_mode: optional(string({ oneOf: TAX_MODES })),
  name: optional(nullable(string({ max: 200 }))),
  description: optional(string({ min: 1, max: 500 })),
  type: optional(string({ oneOf: ["standard", "custom"] })),
  quantity: optional(
    object({
      minimum: required(integer({ min: 1 })),
      maximum: required(integer({ min: 1 })),
    }),
  ),
  status: optional(string({ oneOf: STATUSES })),
  custom_data: optional(nullable(record)),
};
const TRANSACTION_CREATE: Shape = {
  items: required(array(object(items), { min: 1, max: 100 })),
  customer_id: optional(string({ pattern: /^ctm_[a-z0-9]+$/ })),
  custom_data: optional(record),
};
const SUBSCRIPTION_PATCH: Shape = {
  items: optional(array(object(items), { min: 1, max: 100 })),
  proration_billing_mode: optional(string({ oneOf: PRORATION_MODES })),
  on_payment_failure: optional(
    string({ oneOf: ["prevent_change", "apply_change"] }),
  ),
  scheduled_change: optional((value, path, errors) => {
    if (value !== null)
      errors.push({
        field: path,
        message: "Must be null: it removes a pending change",
      });
  }),
  custom_data: optional(nullable(record)),
};
const CANCEL: Shape = {
  effective_from: optional(
    string({ oneOf: ["immediately", "next_billing_period"] }),
  ),
};
const PORTAL: Shape = {
  subscription_ids: optional(
    array(string({ pattern: /^sub_[a-z0-9]+$/ }), { max: 25 }),
  ),
};
const NOTIFICATION_SETTING: Shape = {
  description: required(string({ min: 1, max: 500 })),
  type: required(string({ oneOf: ["url", "email"] })),
  destination: required(string({ pattern: /^https?:\/\/[^\s/]+\S*$/ })),
  subscribed_events: required(
    array(string({ pattern: /^[a-z_]+\.[a-z_.]+$/ })),
  ),
  api_version: optional(integer({ min: 1 })),
  traffic_source: optional(
    string({ oneOf: ["platform", "simulation", "all"] }),
  ),
  include_sensitive_fields: optional(boolean),
};

/** Rejects a query parameter the endpoint does not document; a typo in a filter must not pass silently. */
function checkQuery(query: URLSearchParams, allowed: readonly string[]): void {
  const errors = [...new Set(query.keys())]
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ field: key, message: "Unknown query parameter" }));
  if (errors.length > 0) throw invalidFields(errors);
}

function filterValues(
  query: URLSearchParams,
  key: string,
): string[] | undefined {
  const value = query.get(key);
  if (value === null) return undefined;
  if (!ID_FILTER.test(value))
    throw invalidFields([{ field: key, message: "Has an invalid format" }]);
  return value.split(",");
}

function oneOfFilter(
  query: URLSearchParams,
  key: string,
  allowed: readonly string[],
): string[] | undefined {
  const values = filterValues(query, key);
  if (values?.some((value) => !allowed.includes(value)))
    throw invalidFields([
      { field: key, message: `Must be one of: ${allowed.join(", ")}` },
    ]);
  return values;
}

/** A page of a list, in creation order (ids grow), cut after the cursor, with Paddle's pagination block. */
function page<T extends { id: string }>(
  request: RouteRequest,
  rows: T[],
): RouteReply {
  const perPageText = request.query.get("per_page");
  const perPage = perPageText === null ? 50 : Number(perPageText);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 200)
    throw invalidFields([
      { field: "per_page", message: "Must be an integer from 1 to 200" },
    ]);
  const after = request.query.get("after");
  const sorted = [...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const rest = after === null ? sorted : sorted.filter((row) => row.id > after);
  const shown = rest.slice(0, perPage);
  const hasMore = rest.length > shown.length;
  const next = new URL(request.path, request.origin);
  for (const [key, value] of request.query)
    if (key !== "after") next.searchParams.set(key, value);
  const last = shown[shown.length - 1];
  if (hasMore && last !== undefined) next.searchParams.set("after", last.id);
  return {
    status: 200,
    data: shown,
    pagination: {
      per_page: perPage,
      next: hasMore ? next.toString() : "",
      has_more: hasMore,
      estimated_total: sorted.length,
    },
  };
}

function itemsTotal(subscription: Pick<FakeSubscription, "items">): number {
  return subscription.items.reduce(
    (sum, item) => sum + Number(item.price.unit_price.amount) * item.quantity,
    0,
  );
}

export function createRoutes(store: Store, now: () => number): Route[] {
  const touch = (entity: FakeEntity) => {
    entity.updated_at = store.timestamp();
  };

  const patchEntity = (entity: FakeEntity, body: Record<string, unknown>) => {
    Object.assign(entity, body);
    touch(entity);
  };

  /** What a subscription would look like after this PATCH, with the checks Paddle makes. Nothing is stored. */
  function applyToCopy(
    subscription: FakeSubscription,
    body: Record<string, unknown>,
  ): FakeSubscription {
    const changesItems = body.items !== undefined;
    // The three `subscription_*` locks below are documented constraints (not within 30 minutes of renewal, not
    // past due, not with a pending change) under UNVERIFIED code names (errors.ts): branch on the 409 and the
    // constraint, not on the strings, until the sandbox contract run (#448).
    if (subscription.status === "canceled")
      throw conflict(
        "subscription_update_when_canceled",
        "A canceled subscription cannot be updated",
      );
    if (changesItems) {
      if (body.proration_billing_mode === undefined)
        throw invalidFields([
          {
            field: "proration_billing_mode",
            message: "Required when items change",
          },
        ]);
      if (subscription.status === "past_due")
        throw conflict(
          "subscription_update_when_past_due",
          "Items cannot change while the subscription is past due",
        );
      if (subscription.scheduled_change !== null)
        throw conflict(
          "subscription_locked_pending_changes",
          "A scheduled change is pending",
        );
      if (
        subscription.next_billed_at !== null &&
        Date.parse(subscription.next_billed_at) - now() < RENEWAL_LOCK_MS
      )
        throw conflict(
          "subscription_locked_renewal",
          "The subscription renews within 30 minutes",
        );
    }
    const copy = structuredClone(subscription);
    if (changesItems)
      copy.items = (
        body.items as Array<{ price_id: string; quantity: number }>
      ).map((item) =>
        store.subscriptionItem(item.price_id, item.quantity, now()),
      ) as FakeSubscription["items"];
    if (body.scheduled_change === null) copy.scheduled_change = null;
    if (body.custom_data !== undefined)
      copy.custom_data = body.custom_data as FakeSubscription["custom_data"];
    return copy;
  }

  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/products$/,
      handler: ({ body }) => ({
        status: 201,
        data: store.addProduct(parseBody(body, PRODUCT_CREATE) as never),
      }),
    },
    {
      method: "GET",
      pattern: /^\/products\/([^/]+)$/,
      handler: ({ params }) => ({
        status: 200,
        data: store.get(store.products, params[0] ?? ""),
      }),
    },
    {
      method: "PATCH",
      pattern: /^\/products\/([^/]+)$/,
      handler: ({ params, body }) => {
        const product = store.get(store.products, params[0] ?? "");
        patchEntity(product, parseBody(body, PRODUCT_PATCH));
        return { status: 200, data: product };
      },
    },
    {
      method: "GET",
      pattern: /^\/products$/,
      handler: (request) => {
        checkQuery(request.query, [
          "id",
          "status",
          "type",
          "after",
          "per_page",
        ]);
        const ids = filterValues(request.query, "id");
        const statuses = oneOfFilter(request.query, "status", STATUSES) ?? [
          "active",
        ];
        const types = oneOfFilter(request.query, "type", [
          "standard",
          "custom",
        ]);
        return page(
          request,
          [...store.products.values()].filter(
            (product) =>
              (ids === undefined || ids.includes(product.id)) &&
              statuses.includes(product.status as string) &&
              (types === undefined || types.includes(product.type as string)),
          ),
        );
      },
    },

    {
      method: "POST",
      pattern: /^\/prices$/,
      handler: ({ body }) => ({
        status: 201,
        data: store.addPrice(parseBody(body, PRICE_CREATE) as never),
      }),
    },
    {
      method: "GET",
      pattern: /^\/prices\/([^/]+)$/,
      handler: ({ params }) => ({
        status: 200,
        data: store.get(store.prices, params[0] ?? ""),
      }),
    },
    {
      method: "PATCH",
      pattern: /^\/prices\/([^/]+)$/,
      handler: ({ params, body }) => {
        const price = store.get(store.prices, params[0] ?? "");
        patchEntity(price, parseBody(body, PRICE_PATCH));
        return { status: 200, data: price };
      },
    },
    {
      method: "GET",
      pattern: /^\/prices$/,
      handler: (request) => {
        checkQuery(request.query, [
          "id",
          "product_id",
          "status",
          "recurring",
          "type",
          "after",
          "per_page",
        ]);
        const ids = filterValues(request.query, "id");
        const productIds = filterValues(request.query, "product_id");
        const statuses = oneOfFilter(request.query, "status", STATUSES) ?? [
          "active",
        ];
        const types = oneOfFilter(request.query, "type", [
          "standard",
          "custom",
        ]);
        const recurring = request.query.get("recurring");
        if (recurring !== null && recurring !== "true" && recurring !== "false")
          throw invalidFields([
            { field: "recurring", message: "Must be true or false" },
          ]);
        return page(
          request,
          [...store.prices.values()].filter(
            (price: FakePrice) =>
              (ids === undefined || ids.includes(price.id)) &&
              (productIds === undefined ||
                productIds.includes(price.product_id)) &&
              statuses.includes(price.status) &&
              (types === undefined || types.includes(price.type as string)) &&
              (recurring === null ||
                (price.billing_cycle !== null) === (recurring === "true")),
          ),
        );
      },
    },

    {
      method: "POST",
      pattern: /^\/transactions$/,
      handler: ({ body }) => ({
        status: 201,
        data: store.addTransaction(
          parseBody(body, TRANSACTION_CREATE) as never,
        ),
      }),
    },

    {
      method: "GET",
      pattern: /^\/subscriptions\/([^/]+)$/,
      handler: ({ params }) => ({
        status: 200,
        data: store.get(store.subscriptions, params[0] ?? ""),
      }),
    },
    {
      method: "GET",
      pattern: /^\/subscriptions$/,
      handler: (request) => {
        checkQuery(request.query, [
          "id",
          "customer_id",
          "price_id",
          "status",
          "after",
          "per_page",
        ]);
        const ids = filterValues(request.query, "id");
        const customerIds = filterValues(request.query, "customer_id");
        const priceIds = filterValues(request.query, "price_id");
        const statuses = oneOfFilter(request.query, "status", [
          "active",
          "canceled",
          "past_due",
          "paused",
          "trialing",
        ]);
        return page(
          request,
          [...store.subscriptions.values()].filter(
            (subscription) =>
              (ids === undefined || ids.includes(subscription.id)) &&
              (customerIds === undefined ||
                customerIds.includes(subscription.customer_id)) &&
              (priceIds === undefined ||
                subscription.items.some((item) =>
                  priceIds.includes(item.price.id),
                )) &&
              (statuses === undefined ||
                statuses.includes(subscription.status)),
          ),
        );
      },
    },
    {
      method: "PATCH",
      pattern: /^\/subscriptions\/([^/]+)$/,
      handler: ({ params, body }) => {
        const subscription = store.get(store.subscriptions, params[0] ?? "");
        const copy = applyToCopy(
          subscription,
          parseBody(body, SUBSCRIPTION_PATCH),
        );
        Object.assign(subscription, copy);
        touch(subscription);
        return { status: 200, data: subscription };
      },
    },
    {
      method: "PATCH",
      pattern: /^\/subscriptions\/([^/]+)\/preview$/,
      handler: ({ params, body }) => {
        const subscription = store.get(store.subscriptions, params[0] ?? "");
        const copy = applyToCopy(
          subscription,
          parseBody(body, SUBSCRIPTION_PATCH),
        );
        const difference = itemsTotal(copy) - itemsTotal(subscription);
        const money = (amount: number) => ({
          amount: String(Math.abs(amount)),
          currency_code: copy.currency_code,
        });
        return {
          status: 200,
          data: {
            ...copy,
            update_summary: {
              charge: money(Math.max(difference, 0)),
              credit: money(Math.max(-difference, 0)),
              result: {
                action: difference < 0 ? "credit" : "charge",
                ...money(difference),
              },
            },
          },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/subscriptions\/([^/]+)\/cancel$/,
      handler: ({ params, body }) => {
        const subscription = store.get(store.subscriptions, params[0] ?? "");
        const { effective_from: effectiveFrom = "next_billing_period" } =
          parseBody(body, CANCEL);
        if (subscription.status === "canceled")
          throw conflict(
            "subscription_update_when_canceled",
            "The subscription is already canceled",
          );
        if (effectiveFrom === "immediately") {
          Object.assign(subscription, {
            status: "canceled",
            canceled_at: store.timestamp(),
            scheduled_change: null,
            next_billed_at: null,
          });
        } else {
          if (subscription.scheduled_change !== null)
            throw conflict(
              "subscription_locked_pending_changes",
              "A scheduled change is pending",
            );
          subscription.scheduled_change = {
            action: "cancel",
            effective_at:
              subscription.current_billing_period?.ends_at ??
              stamp(
                addCycle(new Date(now()), {
                  interval: "month",
                  frequency: 1,
                }).getTime(),
              ),
            resumes_at: null,
          };
        }
        touch(subscription);
        return { status: 200, data: subscription };
      },
    },

    {
      method: "POST",
      pattern: /^\/customers\/([^/]+)\/portal-sessions$/,
      handler: ({ params, body }) => {
        const { subscription_ids: subscriptionIds = [] } = parseBody(
          body,
          PORTAL,
        ) as { subscription_ids?: string[] };
        return {
          status: 201,
          data: store.addPortalSession(params[0] ?? "", subscriptionIds),
        };
      },
    },

    {
      method: "POST",
      pattern: /^\/notification-settings$/,
      handler: ({ body }) => ({
        status: 201,
        data: store.addNotificationSetting(
          parseBody(body, NOTIFICATION_SETTING) as never,
        ),
      }),
    },
    {
      method: "GET",
      pattern: /^\/notification-settings$/,
      handler: (request) => {
        checkQuery(request.query, [
          "active",
          "traffic_source",
          ...(store.notificationListPageSize === null ? [] : ["after"]),
        ]);
        const settings = [...store.notificationSettings.values()].map(
          (setting) => {
            if (store.listWithSecrets) return setting;
            const visible = { ...setting };
            delete visible.endpoint_secret_key;
            return visible;
          },
        );
        if (store.notificationListPageSize === null)
          return { status: 200, data: settings };
        const perPage = store.notificationListPageSize;
        request.query.set("per_page", String(perPage));
        return page(request, settings);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/notification-settings\/([^/]+)$/,
      handler: ({ params }) => {
        store.removeNotificationSetting(params[0] ?? "");
        return { status: 204, data: null };
      },
    },
    {
      method: "GET",
      pattern: /^\/notification-settings\/([^/]+)$/,
      handler: ({ params }) => ({
        status: 200,
        data: store.get(store.notificationSettings, params[0] ?? ""),
      }),
    },
  ];
  return routes;
}
