// SPDX-License-Identifier: Apache-2.0

// The wiring of the billing routes: the real database, the adapters this instance has and the switch. This is the one
// place that decides which adapters exist; the Stripe adapter joins the list with #501 and #502.
import "server-only";
import { notFound } from "next/navigation";
import { getDatabase } from "../db/startup.ts";
import { createAdapterRegistry } from "./adapter.ts";
import { createActiveAdapterResolver } from "./active-adapter.ts";
import { isBillingOn } from "./enabled.ts";
import { manualAdapter } from "./manual-adapter.ts";
import { createBillingWebhookHandler } from "./webhook-handler.ts";

export function getBillingAdapterRegistry() {
  return createAdapterRegistry([manualAdapter]);
}

/** The handler of `POST /api/billing/webhook`, wired to the running server. */
export function getBillingWebhookHandler(): (
  request: Request,
) => Promise<Response> {
  const db = getDatabase();
  return createBillingWebhookHandler({
    db,
    guard: { isOn: () => isBillingOn(db), notFound },
    activeAdapter: createActiveAdapterResolver(db, getBillingAdapterRegistry()),
  });
}
