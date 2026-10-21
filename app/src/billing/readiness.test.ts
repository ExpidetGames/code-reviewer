// SPDX-License-Identifier: Apache-2.0

// Which items stand between an instance and a billing that can be on (ADR 0006, 2.14): the rates for every adapter, and for
// Stripe also the two credentials and a passing connection check. Pure.
import { describe, expect, it } from "vitest";
import { BILLING_MISSING_ITEMS, missingItemsOf } from "./readiness.ts";

const RATES = {
  factorA: 50_000,
  minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
  diffAiReserveMicroUsd: 150_000,
};
const STRIPE = {
  checkedAt: "2026-10-20T10:00:00.000Z",
  checkedEnvironment: "test",
} as const;
const LEGAL = { termsUrl: "https://example.com/terms" } as const;
const BOTH = { apiKey: true, webhookSecret: true };

describe("what is missing before billing can be on", () => {
  // #504-T04
  it("is nothing for the manual adapter with every rate set", () => {
    expect(
      missingItemsOf({
        settings: { enabled: false, ...RATES },
        secrets: { apiKey: false, webhookSecret: false },
      }),
    ).toEqual([]);
  });

  // #504-T03
  it("names every missing rate for the manual adapter, and the credentials do not matter", () => {
    expect(
      missingItemsOf({
        settings: { enabled: false, adapter: "manual" },
        secrets: BOTH,
      }),
    ).toEqual([
      "factor_a_missing",
      "minute_rate_diff_missing",
      "minute_rate_dynamic_missing",
      "diff_ai_reserve_missing",
    ]);
  });

  // #504-T03
  it("names a single missing item alone", () => {
    expect(
      missingItemsOf({
        settings: {
          enabled: false,
          ...RATES,
          minuteRateMicroUsd: { diff: 13_000 },
        },
        secrets: BOTH,
      }),
    ).toEqual(["minute_rate_dynamic_missing"]);
  });

  // #504-T03
  it("asks Stripe for both credentials and a passing check, besides the rates", () => {
    expect(
      missingItemsOf({
        settings: { enabled: false, adapter: "stripe" },
        secrets: { apiKey: false, webhookSecret: false },
      }),
    ).toEqual([
      "factor_a_missing",
      "minute_rate_diff_missing",
      "minute_rate_dynamic_missing",
      "diff_ai_reserve_missing",
      "stripe_api_key_missing",
      "stripe_webhook_secret_missing",
      "connection_check_missing",
      "terms_url_missing",
    ]);
  });

  // #504-T03
  it("is nothing for Stripe with the rates, both credentials, a passing check and the terms link", () => {
    expect(
      missingItemsOf({
        settings: {
          enabled: false,
          adapter: "stripe",
          ...RATES,
          stripe: STRIPE,
          legal: LEGAL,
        },
        secrets: BOTH,
      }),
    ).toEqual([]);
  });

  // #504-T03
  it.each([
    [
      "the API key",
      { apiKey: false, webhookSecret: true },
      "stripe_api_key_missing",
    ],
    [
      "the webhook secret",
      { apiKey: true, webhookSecret: false },
      "stripe_webhook_secret_missing",
    ],
  ])("names %s when only it is missing for Stripe", (_name, secrets, item) => {
    expect(
      missingItemsOf({
        settings: {
          enabled: false,
          adapter: "stripe",
          ...RATES,
          stripe: STRIPE,
          legal: LEGAL,
        },
        secrets,
      }),
    ).toEqual([item]);
  });

  // #626-T03
  it("names the terms link alone when it is the only thing missing for Stripe", () => {
    expect(
      missingItemsOf({
        settings: {
          enabled: false,
          adapter: "stripe",
          ...RATES,
          stripe: STRIPE,
          // The privacy link is optional.
          legal: { privacyUrl: "https://example.com/privacy" },
        },
        secrets: BOTH,
      }),
    ).toEqual(["terms_url_missing"]);
  });

  // #626-T03
  it("does not ask the manual adapter for the terms link", () => {
    expect(
      missingItemsOf({
        settings: { enabled: false, adapter: "manual", ...RATES },
        secrets: BOTH,
      }),
    ).toEqual([]);
  });

  // #504-T03
  it("has a stable code for each item", () => {
    expect([...BILLING_MISSING_ITEMS]).toEqual([
      "factor_a_missing",
      "minute_rate_diff_missing",
      "minute_rate_dynamic_missing",
      "diff_ai_reserve_missing",
      "stripe_api_key_missing",
      "stripe_webhook_secret_missing",
      "connection_check_missing",
      "terms_url_missing",
    ]);
  });
});
