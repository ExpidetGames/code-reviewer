// SPDX-License-Identifier: Apache-2.0

// POST /api/runners/v1/jobs/:id/vm: a Dispatcher reports the VM it created for a claim (#493).
import { withRunnerApi } from "../../../../../../../runner-api/shared.ts";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withRunnerApi((api) => api.vmStart(request, id));
}
