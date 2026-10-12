// SPDX-License-Identifier: Apache-2.0

// The handler behind `POST /api/admin/approvals/:id` { "decision": "approve" | "deny" }: the instance admin
// decides a request to link an installation (src/installation-binding/approvals.ts). Order, as for every route of
// the admin portal (src/admin/http.ts): the admin first (not signed in is 401, signed in but not an admin is the
// 404 of a path that does not exist), then where the request comes from, then its content type and body, then the
// service. A person who is not the admin learns nothing: the routes and the pages answer them like any missing
// path. Every answer is `Cache-Control: no-store`.
import type { SessionUser } from "../auth/access-policy.ts";
import type { AdminAccess } from "../admin/access.ts";
import { readJsonObject } from "../http/json-body.ts";
import type { ApprovalService } from "./approvals.ts";
import { APPROVAL_ERROR_STATUS, type ApprovalErrorCode } from "./errors.ts";

const NO_STORE = { "cache-control": "no-store" };
export const APPROVAL_REQUEST_MAX_BYTES = 1024;

function refusal(code: ApprovalErrorCode): Response {
  return Response.json(
    { error: code },
    { status: APPROVAL_ERROR_STATUS[code], headers: NO_STORE },
  );
}

export type ApprovalRouteDependencies = {
  /** Who the request is: called first, on every request. */
  access: () => Promise<AdminAccess>;
  /** The 404 for somebody who is not an admin: Next.js's own, so it is the one of a path that does not exist. Throws. */
  notFound: () => never;
  approvals: ApprovalService;
};

export function createApprovalRouteHandlers({
  access,
  notFound,
  approvals,
}: ApprovalRouteDependencies): {
  decide(request: Request, requestId: string): Promise<Response>;
} {
  async function admin(): Promise<SessionUser | Response> {
    const who = await access();
    if (who.kind === "anonymous")
      return Response.json(
        { error: "UNAUTHENTICATED" },
        { status: 401, headers: NO_STORE },
      );
    if (who.kind === "not_admin") return notFound();
    return who.user;
  }

  return {
    async decide(request, requestId) {
      const who = await admin();
      if (who instanceof Response) return who;
      const body = await readJsonObject(request, APPROVAL_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const keys = Object.keys(body.value);
      const decision = body.value.decision;
      if (
        keys.length !== 1 ||
        (decision !== "approve" && decision !== "deny") ||
        requestId.length > 64
      )
        return refusal("invalid_input");
      try {
        const result =
          decision === "approve"
            ? await approvals.approve(who.id, requestId)
            : await approvals.deny(who.id, requestId);
        return result.ok
          ? Response.json({ ok: true }, { headers: NO_STORE })
          : refusal(result.error);
      } catch {
        console.error(
          "[installation-binding] APPROVAL_UNAVAILABLE: the request was not served.",
        );
        return refusal("unavailable");
      }
    },
  };
}
