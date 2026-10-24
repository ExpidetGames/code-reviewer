// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/runners/v1/version: the version and features of this app, for a Dispatcher (#322).
import { withRunnerApi } from "../../../../../runner-api/shared.ts";

export async function GET(request: Request): Promise<Response> {
  return withRunnerApi((api) => api.version(request));
}
