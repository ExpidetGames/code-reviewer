// SPDX-License-Identifier: LicenseRef-Proprietary

// The HTTP answer of GET /api/health, apart from the route file so a test can call it without a request.
// It says which product and which capabilities this deployment runs (#731), so the pipeline can check that the
// project it staged is the one it meant to promote.
import "server-only";
import { getDeploymentCapabilities } from "../capabilities/shared.ts";
import { getDatabase } from "../db/startup.ts";
import { checkHealth, type HealthReport } from "./health.ts";

/** What the deployment is, or nothing when its settings cannot be read (the report says error then). */
function deploymentFacts() {
  try {
    const { product, capabilities } = getDeploymentCapabilities();
    return { product, capabilities: capabilities.list() };
  } catch {
    return undefined;
  }
}

export async function healthResponse(): Promise<Response> {
  const report = await checkHealth(getDatabase, {
    checkSchema: true,
  }).catch((): HealthReport => ({ status: "error" }));
  const facts = deploymentFacts();
  // A deployment whose capability settings cannot be read is not healthy: it would answer for a product it is not.
  const unreadable = facts === undefined;
  return Response.json(
    unreadable ? { ...report, status: "error" } : { ...report, ...facts },
    {
      status: report.status === "ok" && !unreadable ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
