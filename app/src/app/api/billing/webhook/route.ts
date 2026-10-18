// SPDX-License-Identifier: Apache-2.0

// POST /api/billing/webhook: the Paddle notification destination (#441, ADR 0005, 2.12). Public: no session, the signature of the
// delivery is the authentication (src/auth/access.ts). While billing is off this is the 404 of a path that does not exist and no
// billing table is read (src/billing/enabled.ts). The body is read as raw text inside the handler: the signature covers its exact
// bytes. All logic is in src/billing/webhook-handler.ts; see the billing README, "The webhook".
import { notFound } from "next/navigation";
import { guardBillingRoute } from "@/billing/enabled";
import { getBillingWebhookHandler, isBillingOnNow } from "@/billing/shared";

export const runtime = "nodejs";

const guard = { isOn: isBillingOnNow, notFound };

export async function POST(request: Request): Promise<Response> {
  return guardBillingRoute(guard, getBillingWebhookHandler())(request);
}

// Every other method is the 404 of a missing path while billing is off (a 405 would show that the route exists), and a 405 once it is on.
const notAllowed = guardBillingRoute(guard, async (request: Request) =>
  Response.json(
    { error: "method_not_allowed", method: request.method },
    { status: 405, headers: { allow: "POST" } },
  ),
);
export const GET = notAllowed;
export const HEAD = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = notAllowed;
