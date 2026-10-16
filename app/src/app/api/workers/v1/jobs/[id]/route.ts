// SPDX-License-Identifier: Apache-2.0

// GET /api/workers/v1/jobs/:id: the Worker fetches the job it holds (the per-job credential is the bearer).
import { withWorkerApi } from "../../../../../../runner-api/shared.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withWorkerApi((api) => api.details(request, id));
}
