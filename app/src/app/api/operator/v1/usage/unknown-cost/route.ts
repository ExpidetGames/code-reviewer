// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/operator/v1/usage/unknown-cost?from=&to=&after=<workspace id>&limit=: per workspace and key mode, how many
// runs of the period settled without a known cost (#385). Bearer token; absent (404) until `OPERATOR_API_TOKEN` is
// set. Every method is exported on purpose (see ../../workspaces/route.ts). See src/operator-api/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "usage-unknown-cost" });
}

export {
  handle as DELETE,
  handle as GET,
  handle as HEAD,
  handle as OPTIONS,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
