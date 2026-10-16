// SPDX-License-Identifier: Apache-2.0

// POST /api/workers/v1/jobs/:id/heartbeat: the Worker extends the lease of the job it holds.
import { withWorkerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withWorkerApi((api) => api.heartbeat(request, id));
}
