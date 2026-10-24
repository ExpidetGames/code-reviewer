// SPDX-License-Identifier: LicenseRef-Proprietary

// Liveness for the container health check and the load balancer. Public (see src/auth/access.ts).
import { connection } from "next/server";
import { healthResponse } from "@/health/response";

export async function GET(): Promise<Response> {
  await connection();
  return healthResponse();
}
