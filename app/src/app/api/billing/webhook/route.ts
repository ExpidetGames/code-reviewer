// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/billing/webhook: the one webhook URL of the payment provider the instance runs billing on. Public: no
// session, the signature checked by the active adapter is the authentication. While billing is off, or when the active
// adapter has no webhook (`manual`), it is the 404 of a path that does not exist. All logic is in src/billing/; see its
// README.
import { getBillingWebhookHandler } from "../../../../billing/shared.ts";

// Node, not the edge: the database is a driver. Next.js 16 runs a route handler on Node by default, and a `runtime`
// segment config is refused with `cacheComponents` (the build fails), so none is exported; the test below pins "not edge".
export async function POST(request: Request): Promise<Response> {
  return getBillingWebhookHandler()(request);
}
