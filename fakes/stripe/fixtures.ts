// SPDX-License-Identifier: LicenseRef-Proprietary

// The shapes in fakes/fixtures/stripe/ (see its README): each object the fake makes starts as a copy of one.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const STRIPE_FIXTURE_NAMES = [
  "account",
  "charge",
  "checkout-session",
  "customer",
  "dispute",
  "event",
  "invoice",
  "payment-intent",
  "refund",
  "tax-id",
  "webhook-endpoint",
] as const;
export type StripeFixtureName = (typeof STRIPE_FIXTURE_NAMES)[number];

const DIRECTORY = join(import.meta.dirname, "..", "fixtures", "stripe");

/** A fresh copy of the fixture, for the caller to change. */
export function loadStripeFixture(
  name: StripeFixtureName,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(DIRECTORY, `${name}.json`), "utf8"),
  ) as Record<string, unknown>;
}
