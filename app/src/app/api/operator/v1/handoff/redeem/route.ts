// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/operator/v1/handoff/redeem { token }: who a handoff token of "Manage plan" was made for, once.
// Bearer token; absent (404) until `OPERATOR_API_TOKEN` is set. See src/operator-api/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "handoff-redeem" });
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
