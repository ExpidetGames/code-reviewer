// SPDX-License-Identifier: Apache-2.0

// GET|PUT /api/operator/v1/model-tiers: which model backs each managed tier (#280). Bearer token; absent (404) until
// `OPERATOR_API_TOKEN` is set. See src/operator-api/README.md and src/model-tiers/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "model-tiers" });
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
