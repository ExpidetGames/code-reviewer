// SPDX-License-Identifier: Apache-2.0

// What the webhook reads of a Paddle notification, and nothing else (#441). The body is untrusted until its signature has been
// verified, and even then only the fields listed here are read: a field that is not listed is dropped, never stored, never
// logged. Unlike the schemas of the API client (`paddle-schemas.ts`) these are lenient about values the app has no use for
// (a new status, an unknown scheduled action): an event that cannot be applied is recorded and answered, not retried for days.
import "server-only";
import { z } from "zod";
import { formatTimestamp } from "../db/codecs.ts";

const id = z.string().min(1).max(128);

export const webhookEnvelopeSchema = z.object({
  event_id: id,
  event_type: id,
  occurred_at: z.string().min(1).max(64),
  data: z.unknown(),
});

/** A subscription as an event shows it. `transaction_id` is only on `subscription.created` (Paddle's documentation). */
export const webhookSubscriptionSchema = z.object({
  id,
  status: z.string().max(64),
  customer_id: id,
  started_at: z.string().max(64).nullish(),
  next_billed_at: z.string().max(64).nullish(),
  canceled_at: z.string().max(64).nullish(),
  current_billing_period: z
    .object({ starts_at: z.string().max(64), ends_at: z.string().max(64) })
    .nullish(),
  scheduled_change: z
    .object({ action: z.string().max(64), effective_at: z.string().max(64) })
    .nullish(),
  items: z
    .array(
      z.object({
        status: z.string().max(64).optional(),
        quantity: z.number(),
        price: z.object({ id }),
      }),
    )
    .max(50),
  custom_data: z.record(z.string(), z.unknown()).nullish(),
  transaction_id: id.nullish(),
});
export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>;

/**
 * The canonical text of a Paddle timestamp (RFC 3339, microseconds): milliseconds, UTC, a fixed width that compares as time.
 * Undefined for anything that is no date in the years 2000 to 2999, so the width holds and a wild year cannot win a comparison.
 */
export function canonicalTime(text: string): string | undefined {
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) return undefined;
  const iso = formatTimestamp(new Date(milliseconds));
  return /^2\d{3}-/.test(iso) ? iso : undefined;
}
