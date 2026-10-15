// SPDX-License-Identifier: Apache-2.0

// GET /api/operator/v1/workspaces/{id}/usage?after=&limit=&from=&to=: the settled usage records of one workspace.
// Bearer token; absent (404) until `OPERATOR_API_TOKEN` is set. See src/operator-api/README.md.
import { connection } from "next/server";
import { withOperatorApi } from "../../../../../../../operator-api/shared.ts";

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();
  const { id } = await context.params;
  return withOperatorApi(request, { kind: "workspace-usage", workspaceId: id });
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
