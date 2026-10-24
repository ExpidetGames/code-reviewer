// SPDX-License-Identifier: LicenseRef-Proprietary

// GET|PUT|DELETE /api/operator/v1/plan-management: the operator-configured page "Manage plan" hands people over to.
// Bearer token; absent (404) until `OPERATOR_API_TOKEN` is set. See src/operator-api/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "plan-management" });
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
