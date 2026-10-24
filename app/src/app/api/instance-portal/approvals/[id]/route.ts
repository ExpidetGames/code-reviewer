// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/admin/approvals/:id { "decision": "approve" | "deny" }: the instance admin decides a request to link
// an installation. Not signed in is 401, signed in but not an admin is a 404 (src/admin/access.ts); the proxy has
// done that first and the handler does it again before anything is read. The logic is in
// src/installation-binding/approvals.ts.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lookupAdmin } from "@/admin/session";
import { createApprovalRouteHandlers } from "@/installation-binding/approvals-http";
import { getInstallationBinding } from "@/installation-binding/shared";

export async function POST(
  request: Request,
  context: RouteContext<"/api/instance-portal/approvals/[id]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { id } = await context.params;
  return createApprovalRouteHandlers({
    access: lookupAdmin,
    notFound,
    approvals: getInstallationBinding().approvals,
  }).decide(request, id);
}
