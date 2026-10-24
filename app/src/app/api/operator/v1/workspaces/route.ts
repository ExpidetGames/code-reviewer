// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/operator/v1/workspaces: a page of workspaces (id, slug, creation time). Public for the session guard:
// the bearer token is the credential, and without `OPERATOR_API_TOKEN` the route does not exist. Every method is
// exported on purpose, so that a method this route does not offer is answered by the API (405, or the 404 of a
// missing path while the API is off) and not by Next.js. All logic is in src/operator-api/; see its README.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../operator-api/shared.ts";

async function handle(request: Request): Promise<Response> {
  await connection();
  return withOperatorApi(request, { kind: "workspaces" });
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
