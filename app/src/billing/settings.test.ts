// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readBillingSettings } from "./settings.ts";

describe("the stored billing settings", () => {
  // #491-T06
  it("reads a value of the old shape with the extra fields ignored", () => {
    expect(
      readBillingSettings({
        environment: "live",
        clientToken: "live_0123456789abcdef0123456789a",
        graceDays: 7,
        enabled: true,
      }),
    ).toEqual({ enabled: true });
  });

  // #491-T06
  it.each([
    ["true", "a string"],
    [1, "a number"],
    [null, "null"],
    [undefined, "nothing"],
    ["yes", "other text"],
    [false, "false"],
  ] as Array<[unknown, string]>)("reads enabled %j (%s) as off", (enabled) => {
    expect(
      readBillingSettings({ environment: "sandbox", enabled }).enabled,
    ).toBe(false);
  });

  // #491-T06
  it.each([null, undefined, "on", 3, [], [true]])(
    "reads %j, which is no object, as off",
    (stored) => {
      expect(readBillingSettings(stored)).toEqual({ enabled: false });
    },
  );

  // #494-T11
  it("reads the rates it finds and the switch next to them", () => {
    expect(
      readBillingSettings({
        enabled: true,
        factorA: 12_000,
        minuteRateMicroUsd: { diff: 10_000, dynamic: 25_000 },
        diffAiReserveMicroUsd: 300_000,
      }),
    ).toStrictEqual({
      enabled: true,
      factorA: 12_000,
      minuteRateMicroUsd: { diff: 10_000, dynamic: 25_000 },
      diffAiReserveMicroUsd: 300_000,
    });
  });

  // #494-T11
  it.each([
    ["a string", { factorA: "12000" }],
    ["a float", { factorA: 12_000.5 }],
    ["below 1", { factorA: 100 }],
    ["negative", { factorA: -1 }],
    ["null", { factorA: null }],
    ["a boolean", { factorA: true }],
  ])("reads a damaged factor (%s) as not set", (_name, stored) => {
    expect(readBillingSettings({ enabled: true, ...stored })).toStrictEqual({
      enabled: true,
    });
  });

  // #494-T11
  it("reads a damaged rate, group or reserve as not set, field by field", () => {
    expect(
      readBillingSettings({
        enabled: false,
        factorA: 12_000,
        minuteRateMicroUsd: { diff: -5, dynamic: 25_000 },
        diffAiReserveMicroUsd: "lots",
      }),
    ).toStrictEqual({
      enabled: false,
      factorA: 12_000,
      minuteRateMicroUsd: { dynamic: 25_000 },
    });
    expect(
      readBillingSettings({ enabled: true, minuteRateMicroUsd: "free" }),
    ).toStrictEqual({ enabled: true });
    expect(
      readBillingSettings({ enabled: true, minuteRateMicroUsd: [1, 2] }),
    ).toStrictEqual({ enabled: true });
  });
});

describe("the adapter, the numbers and the state of the Stripe check in the stored settings", () => {
  // #504-T09
  it("reads the start credit, the low-balance threshold and the hourly brake as stored", () => {
    expect(
      readBillingSettings({
        enabled: false,
        startCreditMicroUsd: 0,
        lowBalanceMicroUsd: 7_000_000,
        hourlyReviewLimit: 30,
      }),
    ).toStrictEqual({
      enabled: false,
      startCreditMicroUsd: 0,
      lowBalanceMicroUsd: 7_000_000,
      hourlyReviewLimit: 30,
    });
  });

  // #504-T09
  it.each([
    ["startCreditMicroUsd", "2"],
    ["startCreditMicroUsd", -1],
    ["lowBalanceMicroUsd", 1.5],
    ["hourlyReviewLimit", 0],
    ["hourlyReviewLimit", null],
  ])("reads a damaged %s (%j) as not set", (field, value) => {
    expect(
      readBillingSettings({ enabled: true, [field]: value }),
    ).toStrictEqual({ enabled: true });
  });

  // #504-T04
  it("reads the adapter only when it is an adapter id", () => {
    expect(readBillingSettings({ adapter: "stripe" })).toStrictEqual({
      enabled: false,
      adapter: "stripe",
    });
    for (const adapter of ["Stripe!", "", 5, null, {}])
      expect(readBillingSettings({ adapter })).toStrictEqual({
        enabled: false,
      });
  });

  // #504-T03
  it("reads the passing connection check with its environment, and a damaged one as no check", () => {
    const stripe = {
      checkedAt: "2026-10-20T10:00:00.000Z",
      checkedEnvironment: "test",
      webhookEndpointId: "we_123",
    };
    expect(readBillingSettings({ stripe })).toStrictEqual({
      enabled: false,
      stripe,
    });
    expect(
      readBillingSettings({
        stripe: { checkedAt: "yesterday", checkedEnvironment: "staging" },
      }),
    ).toStrictEqual({ enabled: false });
    expect(readBillingSettings({ stripe: "passed" })).toStrictEqual({
      enabled: false,
    });
  });
});

describe("the stored links to the terms and privacy statement", () => {
  // #626-T02
  it("reads the links next to the switch", () => {
    expect(
      readBillingSettings({
        enabled: false,
        legal: {
          termsUrl: "https://example.com/terms",
          privacyUrl: "https://example.com/privacy",
        },
      }),
    ).toStrictEqual({
      enabled: false,
      legal: {
        termsUrl: "https://example.com/terms",
        privacyUrl: "https://example.com/privacy",
      },
    });
  });

  // #626-T02
  it.each([
    ["a string", "https://example.com/terms"],
    ["an http link", { termsUrl: "http://example.com/terms" }],
    ["a link with credentials", { termsUrl: "https://a:b@example.com/t" }],
  ])("reads %s as no link", (_name, legal) => {
    expect(readBillingSettings({ enabled: true, legal })).toStrictEqual({
      enabled: true,
    });
  });
});
