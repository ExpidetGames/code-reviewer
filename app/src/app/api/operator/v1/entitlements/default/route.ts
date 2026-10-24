// SPDX-License-Identifier: LicenseRef-Proprietary

// GET and PUT /api/operator/v1/entitlements/default: the entitlements of every workspace without a row of its own.
// Bearer token; absent (404) until `OPERATOR_API_TOKEN` is set. See src/operator-api/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "default-entitlements" });
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
