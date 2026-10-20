# Stripe fixtures

The shapes the Stripe fake (`fakes/stripe/`, #500) builds its objects from. Every value is a dummy; there is no real
data in this directory.

- **Recorded against the Stripe sandbox (test mode), 2026-10-20, API version `2025-03-31.basil` with
  `managed_payments_preview=v1`:** `customer.json`, `tax-id.json`, `checkout-session.json`, `payment-intent.json`,
  `webhook-endpoint.json` and `account.json` (the fields of a real answer; ids, times, names and amounts replaced).
- **From the API reference, not recorded** (a sandbox payment cannot be made through the API alone, and the objects it
  would leave behind cannot be deleted): `charge.json`, `refund.json`, `dispute.json` and `event.json`. The fake fills
  the fields the app reads (`stripe-schemas.ts`); the rest is there for shape.
- An object is a template: the fake copies it and sets the ids, the times and the fields of the request.
