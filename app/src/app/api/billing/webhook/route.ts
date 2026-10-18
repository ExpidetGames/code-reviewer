// SPDX-License-Identifier: Apache-2.0

// POST /api/billing/webhook: the Paddle notification destination (#441, ADR 0005, 2.12). Public: no session, the signature of the
// delivery is the authentication (src/auth/access.ts). While billing is off this is the 404 of a path that does not exist and no
// billing table is read (src/billing/enabled.ts). The body is read as raw text inside the handler: the signature covers its exact
// bytes. All logic is in src/billing/webhook-handler.ts; see the billing README, "The webhook".
import { notFound } from "next/navigation";
import { guardBillingRoute } from "@/billing/enabled";
import { getBillingWebhookHandler, isBillingOnNow } from "@/billing/shared";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return guardBillingRoute(
    { isOn: isBillingOnNow, notFound },
    getBillingWebhookHandler(),
  )(request);
}
