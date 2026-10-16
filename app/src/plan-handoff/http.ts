// SPDX-License-Identifier: Apache-2.0

// The handler behind `POST /api/w/:workspace/plan-handoff`, with its collaborators passed in so the route file only
// wires the real ones and tests wire the real services over a test database. The order is the contract; each step
// ends the request on failure:
//
//   1. configured   no usable `plan_management_url`: the answer of a path that does not exist (Next's `notFound`)
//   2. same site    `Sec-Fetch-Site` / `Origin` (src/http/request-checks.ts)          303 back, plan_error=cross_site_request
//   3. access       the session and the role (`manage_plan`: an Admin or an Owner)    401 / 404 / 403, access-response.ts
//   4. limit        per person and workspace                                         303 back, plan_error=rate_limited
//   5. token        made, stored as a hash, and the browser is sent to the page         303
//
// The request body and query are never read: the target of the redirect is the instance setting and nothing of the
// request, so there is no open redirect. The answer is `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
// (the address of this app is not passed on with the token). The log gets the workspace id and a result code, never
// a token and never a person.
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import type { HandoffRole } from "../db/repositories/plan-handoff-tokens-repository.ts";
import {
  settingsPathWithPlanError,
  type PlanHandoffErrorCode,
} from "./errors.ts";
import { handoffLocation } from "./url.ts";

const NO_STORE = { "cache-control": "no-store" };

export type PlanHandoffIssue =
  | { allowed: true; token: string }
  | { allowed: false; retryAfterSeconds: number };

export type PlanHandoffRouteDependencies = {
  /** The configured page in its stored form, or null (unset, or not valid). */
  planManagementUrl: () => Promise<string | null>;
  /** Next.js's own 404: the answer of a path that does not exist. Throws. */
  notFound: () => never;
  /** Counts the click and, when it is allowed, makes the token for the person with the role they have now. */
  issue: (input: {
    workspaceId: string;
    userId: string;
    role: HandoffRole;
  }) => Promise<PlanHandoffIssue>;
  log: { info(line: string): void };
};

/**
 * Resolves the person and their role for `manage_plan`, then runs the handler: the route file passes
 * `(handler) => withWorkspace(workspace, "manage_plan", handler)`, so the guard stays where every other workspace
 * route has it (and `src/workspaces/guard-rule.test.ts` can see it).
 */
export type WithAccess = (
  handler: (access: WorkspaceAccess) => Promise<Response>,
) => Promise<Response>;

export type PlanHandoffRoute = {
  post(
    request: Request,
    slug: string,
    withAccess: WithAccess,
  ): Promise<Response>;
};

/** A refused click: back to the settings page of the workspace, which says why (errors.ts). Never a body. */
function refusal(slug: string, code: PlanHandoffErrorCode): Response {
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, location: settingsPathWithPlanError(slug, code) },
  });
}

export function createPlanHandoffRoute({
  planManagementUrl,
  notFound,
  issue,
  log,
}: PlanHandoffRouteDependencies): PlanHandoffRoute {
  return {
    async post(request, slug, withAccess) {
      const page = await planManagementUrl();
      if (page === null) return notFound();
      if (isCrossSite(request)) return refusal(slug, "cross_site_request");
      return withAccess(async (access) => {
        // The matrix lets an Admin and an Owner through; the token is bound to the role, which can only be one of them.
        const role = access.role;
        if (role !== "owner" && role !== "admin")
          return Response.json(
            { error: "forbidden" },
            { status: 403, headers: NO_STORE },
          );
        const workspaceId = access.workspace.id;
        const made = await issue({
          workspaceId,
          userId: access.user.id,
          role,
        });
        if (!made.allowed) {
          log.info(
            `[plan-handoff] workspace=${workspaceId} result=rate_limited`,
          );
          return refusal(slug, "rate_limited");
        }
        log.info(`[plan-handoff] workspace=${workspaceId} result=ok`);
        return new Response(null, {
          status: 303,
          headers: {
            ...NO_STORE,
            location: handoffLocation(page, made.token),
            "referrer-policy": "no-referrer",
          },
        });
      });
    },
  };
}
