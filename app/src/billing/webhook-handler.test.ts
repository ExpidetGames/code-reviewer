// SPDX-License-Identifier: LicenseRef-Proprietary

// #497-T13: the structure of the webhook route. It makes no outbound call (the sources that run in it do not even import
// a way to make one; the behavior is in webhook-handler.integration.test.ts), every status and log line comes from an
// `as const` set, and the route file is a thin Node-runtime wrapper.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BILLING_WEBHOOK_REJECTION_CODES } from "./adapter.ts";
import {
  BILLING_WEBHOOK_LOG_CODES,
  BILLING_WEBHOOK_MAX_BODY_BYTES,
  BILLING_WEBHOOK_REJECTION_STATUS,
} from "./webhook-handler.ts";

const SRC = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("the billing webhook route", () => {
  // #497-T13
  it("runs sources that cannot make an outbound call", () => {
    const forbidden =
      /\bfetch\s*\(|from\s+["'](?:node:)?(?:https?|http2|net|tls|dgram)["']|from\s+["']undici["']|XMLHttpRequest|new WebSocket/;
    for (const file of [
      "billing/webhook-handler.ts",
      "billing/apply-event.ts",
      "billing/adapter.ts",
      "billing/manual-adapter.ts",
      "billing/manual-credit.ts",
      "db/repositories/billing-topup-intents-repository.ts",
      "db/repositories/billing-topup-intent-directory-repository.ts",
      "db/repositories/billing-webhook-events-repository.ts",
    ])
      expect(read(file), file).not.toMatch(forbidden);
  });

  // #497-T13
  it("answers every code of the adapter with a status of its own, from a closed set", () => {
    expect(Object.keys(BILLING_WEBHOOK_REJECTION_STATUS).sort()).toEqual(
      [...BILLING_WEBHOOK_REJECTION_CODES].sort(),
    );
    for (const status of Object.values(BILLING_WEBHOOK_REJECTION_STATUS))
      expect([400, 401]).toContain(status);
    expect(new Set(BILLING_WEBHOOK_LOG_CODES).size).toBe(
      BILLING_WEBHOOK_LOG_CODES.length,
    );
    for (const code of BILLING_WEBHOOK_LOG_CODES)
      expect(code).toMatch(/^billing_webhook_[a-z_]+$/);
  });

  // #497-T13
  it("limits the raw body to a few hundred kilobytes", () => {
    expect(BILLING_WEBHOOK_MAX_BODY_BYTES).toBeGreaterThanOrEqual(64 * 1024);
    expect(BILLING_WEBHOOK_MAX_BODY_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  // #497-T13
  it("is a POST route on the default Node runtime that only hands the request to the wired handler", () => {
    const route = read("app/api/billing/webhook/route.ts");

    // Node is the default of Next.js 16; a `runtime` export breaks the build with cacheComponents, so there is none.
    expect(route).not.toMatch(/export const runtime/);
    expect(route).toMatch(/export async function POST\(/);
    expect(route).not.toMatch(
      /export (async )?function (GET|PUT|PATCH|DELETE)/,
    );
    expect(route).toMatch(/getBillingWebhookHandler\(\)/);
    // All logic is in src/billing/.
    expect(route.split("\n").length).toBeLessThan(30);
  });
});
