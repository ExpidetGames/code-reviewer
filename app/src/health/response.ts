// SPDX-License-Identifier: Apache-2.0

// The HTTP answer of GET /api/health, apart from the route file so a test can call it without a request.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { isServerless } from "../runtime/mode.ts";
import { checkHealth, type HealthReport } from "./health.ts";

export async function healthResponse(): Promise<Response> {
  const report = await checkHealth(getDatabase, {
    checkSchema: isServerless(),
  }).catch((): HealthReport => ({ status: "error" }));
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
