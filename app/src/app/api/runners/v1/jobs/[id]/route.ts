// SPDX-License-Identifier: Apache-2.0

// GET /api/runners/v1/jobs/:id: the status of a job, for a Dispatcher (#364).
import { withRunnerApi } from "../../../../../../runner-api/shared.ts";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.jobState(request, id));
}
