// SPDX-License-Identifier: Apache-2.0

// Any other path below /api/operator/v1: a JSON 404 for a caller with the right token, the 404 of a missing path
// while the API is off, 401 otherwise. See src/operator-api/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "unknown" });
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
