// SPDX-License-Identifier: Apache-2.0

// POST /api/runners/v1/jobs/:id/heartbeat: the runner extends the lease of the job it holds.
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.heartbeat(request, id));
}
