// Liveness for the container health check and the load balancer. Public (see src/auth/access.ts).
import { connection } from "next/server";
import { getDatabase } from "@/db/startup";
import { checkHealth } from "@/health/health";

export async function GET(): Promise<Response> {
  await connection();
  const report = await checkHealth(getDatabase).catch(
    () => ({ status: "error" }) as const,
  );
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
