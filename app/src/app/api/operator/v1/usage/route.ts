// SPDX-License-Identifier: Apache-2.0

// GET /api/operator/v1/usage?after=<cursor>&limit=: the settled usage records of every workspace, ordered by
// (settledAt, id). Bearer token; absent (404) until `OPERATOR_API_TOKEN` is set. Every method is exported on purpose
// (see ../workspaces/route.ts). See src/operator-api/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "usage" });
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
