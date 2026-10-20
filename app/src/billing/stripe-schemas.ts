// SPDX-License-Identifier: Apache-2.0

// Our own schemas of the fields of Stripe's objects that the billing module reads (ADR 0006, 2.13; #500). Only what is
// read is listed; a field that is not here is dropped, so a later change at Stripe cannot reach the app, and a field
// that is here with another type is refused (`invalid_response`). Nothing personal is read: no email, no address, no
// card. An object that can be expanded is read as its id (the client never expands, but an event may carry it expanded).
import "server-only";
import { z } from "zod";

const text = z.string();
const metadata = z.record(z.string(), z.string()).default({});

/** An id, or an expanded object that has one: read as the id. */
const expandableId = z
  .union([z.string(), z.object({ id: z.string() })])
  .transform((value) => (typeof value === "string" ? value : value.id));

export const stripeTaxIdSchema = z.object({
  id: text,
  object: z.literal("tax_id"),
  type: text,
  value: text,
  verification: z.object({ status: text }).nullish(),
});
export type StripeTaxId = z.infer<typeof stripeTaxIdSchema>;

export const stripeCustomerSchema = z.object({
  id: text,
  object: z.literal("customer"),
  name: text.nullish(),
  metadata,
  livemode: z.boolean().optional(),
  /** Only when the customer was asked for with `expand[]=tax_ids`. */
  tax_ids: z
    .object({ data: z.array(stripeTaxIdSchema), has_more: z.boolean() })
    .optional(),
  /** `true` on the answer for a customer that was deleted (Stripe answers 200 for it). */
  deleted: z.literal(true).optional(),
});
export type StripeCustomer = z.infer<typeof stripeCustomerSchema>;

export const stripeCheckoutSessionSchema = z.object({
  id: text,
  object: z.literal("checkout.session"),
  status: z.enum(["open", "complete", "expired"]),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  mode: text,
  /** The page of the buyer; null once the session is no longer open. */
  url: text.nullable(),
  customer: expandableId.nullable(),
  /** Null until the buyer has paid: the payment intent comes into being with the payment. */
  payment_intent: expandableId.nullable(),
  client_reference_id: text.nullable(),
  metadata,
  amount_subtotal: z.number().nullable(),
  amount_total: z.number().nullable(),
  total_details: z.object({ amount_tax: z.number() }).nullish(),
  currency: text.nullable(),
  expires_at: z.number(),
  created: z.number(),
  livemode: z.boolean(),
});
export type StripeCheckoutSession = z.infer<typeof stripeCheckoutSessionSchema>;

export const stripePaymentIntentSchema = z.object({
  id: text,
  object: z.literal("payment_intent"),
  status: text,
  amount: z.number(),
  amount_received: z.number(),
  currency: text,
  latest_charge: expandableId.nullable(),
  customer: expandableId.nullable(),
  metadata,
  created: z.number(),
  livemode: z.boolean(),
});
export type StripePaymentIntent = z.infer<typeof stripePaymentIntentSchema>;

export const stripeChargeSchema = z.object({
  id: text,
  object: z.literal("charge"),
  amount: z.number(),
  amount_refunded: z.number(),
  currency: text,
  payment_intent: expandableId.nullable(),
  status: text,
  paid: z.boolean(),
  refunded: z.boolean(),
  disputed: z.boolean(),
  metadata,
  created: z.number(),
});
export type StripeCharge = z.infer<typeof stripeChargeSchema>;

export const stripeRefundSchema = z.object({
  id: text,
  object: z.literal("refund"),
  amount: z.number(),
  currency: text,
  charge: expandableId.nullable(),
  payment_intent: expandableId.nullable(),
  /** `pending`, `requires_action`, `succeeded`, `failed` or `canceled`; null where Stripe gives none. */
  status: text.nullable(),
  reason: text.nullable(),
  failure_reason: text.nullish(),
  metadata,
  created: z.number(),
});
export type StripeRefund = z.infer<typeof stripeRefundSchema>;

export const stripeWebhookEndpointSchema = z.object({
  id: text,
  object: z.literal("webhook_endpoint"),
  url: text,
  status: text,
  enabled_events: z.array(text),
  description: text.nullish(),
  api_version: text.nullish(),
  /** The signing secret (`whsec_...`): in the answer to the create and in no other. */
  secret: text.optional(),
  livemode: z.boolean().optional(),
});
export type StripeWebhookEndpoint = z.infer<typeof stripeWebhookEndpointSchema>;

export const stripeAccountSchema = z.object({
  id: text,
  object: z.literal("account"),
  charges_enabled: z.boolean(),
  details_submitted: z.boolean(),
  country: text,
  default_currency: text.optional(),
});
export type StripeAccount = Omit<z.infer<typeof stripeAccountSchema>, "object">;

/** What Stripe answers to a DELETE. */
export const stripeDeletedSchema = z.object({
  id: text,
  object: text,
  deleted: z.literal(true),
});

export const stripeListSchema = <S extends z.ZodType>(item: S) =>
  z.object({
    object: z.literal("list"),
    data: z.array(item),
    has_more: z.boolean(),
  });

/** The error body: only the two plain identifiers are ever read from it. */
export const stripeErrorSchema = z.object({
  error: z.object({
    type: text.optional(),
    code: text.optional(),
  }),
});
