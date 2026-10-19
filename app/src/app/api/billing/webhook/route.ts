// SPDX-License-Identifier: Apache-2.0

// POST /api/billing/webhook: the one webhook URL of the payment provider the instance runs billing on. Public: no
// session, the signature checked by the active adapter is the authentication. While billing is off, or when the active
// adapter has no webhook (`manual`), it is the 404 of a path that does not exist. All logic is in src/billing/; see its
// README.
import { getBillingWebhookHandler } from "../../../../billing/shared.ts";

// The signature is an HMAC over the exact bytes of the body and the database is a driver: Node, not the edge.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return getBillingWebhookHandler()(request);
}
