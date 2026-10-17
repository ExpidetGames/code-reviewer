// SPDX-License-Identifier: Apache-2.0

// What the app reads of Paddle's answers, and nothing else (ADR 0005, 2.10). Every response is untrusted: it is
// parsed with these schemas, a field that is not listed is dropped (never passed on, never trusted), and an
// answer that does not fit is refused by the client as `invalid_response`. Amounts stay strings, as Paddle
// writes them (the smallest unit of the currency, "1234"); dates stay text.
import "server-only";
import { z } from "zod";

const customData = z.record(z.string(), z.unknown()).nullable().optional();
const money = z.object({ amount: z.string(), currency_code: z.string() });
const cycle = z.object({
  interval: z.enum(["day", "week", "month", "year"]),
  frequency: z.number().int(),
});

export const paddleProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  tax_category: z.string().optional(),
  status: z.enum(["active", "archived"]),
  custom_data: customData,
  created_at: z.string(),
  updated_at: z.string(),
});
export type PaddleProduct = z.infer<typeof paddleProductSchema>;

export const paddlePriceSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  description: z.string(),
  name: z.string().nullable().optional(),
  status: z.enum(["active", "archived"]),
  tax_mode: z.enum(["account_setting", "external", "internal", "location"]),
  billing_cycle: cycle.nullable(),
  trial_period: cycle.nullable().optional(),
  unit_price: money,
  unit_price_overrides: z
    .array(
      z.object({
        country_codes: z.array(z.string()),
        unit_price: money,
      }),
    )
    .optional(),
  custom_data: customData,
  created_at: z.string(),
  updated_at: z.string(),
});
export type PaddlePrice = z.infer<typeof paddlePriceSchema>;

export const paddleTransactionSchema = z.object({
  id: z.string(),
  status: z.string(),
  customer_id: z.string().nullable(),
  subscription_id: z.string().nullable().optional(),
  currency_code: z.string().optional(),
  items: z
    .array(z.object({ price_id: z.string().optional(), quantity: z.number() }))
    .optional(),
  custom_data: customData,
  checkout: z.object({ url: z.string().nullable() }).nullable().optional(),
  created_at: z.string(),
});
export type PaddleTransaction = z.infer<typeof paddleTransactionSchema>;

const subscriptionFields = {
  id: z.string(),
  status: z.enum(["active", "canceled", "past_due", "paused", "trialing"]),
  customer_id: z.string(),
  currency_code: z.string(),
  started_at: z.string().nullable().optional(),
  next_billed_at: z.string().nullable(),
  canceled_at: z.string().nullable().optional(),
  paused_at: z.string().nullable().optional(),
  current_billing_period: z
    .object({ starts_at: z.string(), ends_at: z.string() })
    .nullable(),
  billing_cycle: cycle.optional(),
  scheduled_change: z
    .object({
      action: z.enum(["cancel", "pause", "resume"]),
      effective_at: z.string(),
    })
    .nullable(),
  items: z.array(
    z.object({
      status: z.string().optional(),
      quantity: z.number(),
      price: z.object({
        id: z.string(),
        product_id: z.string(),
        unit_price: money.optional(),
      }),
    }),
  ),
  custom_data: customData,
};

export const paddleSubscriptionSchema = z.object(subscriptionFields);
export type PaddleSubscription = z.infer<typeof paddleSubscriptionSchema>;

const summaryMoney = z.object({
  amount: z.string(),
  currency_code: z.string(),
});

/** The answer of `PATCH /subscriptions/{id}/preview`: the subscription as it would be, and what it would cost. */
export const paddleSubscriptionPreviewSchema = z.object({
  ...subscriptionFields,
  update_summary: z
    .object({
      credit: summaryMoney.optional(),
      charge: summaryMoney.optional(),
      result: z
        .object({
          action: z.enum(["credit", "charge"]),
          amount: z.string(),
          currency_code: z.string(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});
export type PaddleSubscriptionPreview = z.infer<
  typeof paddleSubscriptionPreviewSchema
>;

export const paddlePortalSessionSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  urls: z.object({
    general: z.object({ overview: z.string() }),
    subscriptions: z.array(
      z.object({
        id: z.string(),
        cancel_subscription: z.string(),
        update_subscription_payment_method: z.string(),
      }),
    ),
  }),
});
export type PaddlePortalSession = z.infer<typeof paddlePortalSessionSchema>;

export const paddleNotificationSettingSchema = z.object({
  id: z.string(),
  description: z.string(),
  type: z.string(),
  destination: z.string(),
  active: z.boolean(),
  api_version: z.number().int(),
  traffic_source: z.string(),
  subscribed_events: z.array(z.object({ name: z.string() })),
  /** The secret that signs this destination's webhooks. Treat it like a key: store it encrypted, never log it. */
  endpoint_secret_key: z.string(),
});
export type PaddleNotificationSetting = z.infer<
  typeof paddleNotificationSettingSchema
>;

/** The pagination block of a list answer; `next` is a full URL carrying the `after` cursor. */
export const paddlePaginationSchema = z.object({
  next: z.string().nullable().optional(),
  has_more: z.boolean(),
});

export function envelope<T extends z.ZodType>(data: T) {
  return z.object({ data });
}

export function listEnvelope<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    meta: z.object({ pagination: paddlePaginationSchema }),
  });
}

/** `{ error: { type, code, detail } }`. Only `code` is ever read, and only when it is a plain identifier. */
export const paddleErrorSchema = z.object({
  error: z.object({ code: z.string() }),
});
