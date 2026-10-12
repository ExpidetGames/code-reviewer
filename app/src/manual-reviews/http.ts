// SPDX-License-Identifier: Apache-2.0

// The handlers behind `GET /api/repositories/:repositoryId/pull-requests` (the pull requests a
// person can pick) and `POST /api/repositories/:repositoryId/reviews` (start a command for one of
// them), with their collaborators passed in so the route files only wire the real ones and tests wire
// fakes.
//
// Order: the user first (nothing is read or looked at before the caller is known), then, for the
// start, where the request comes from, its content type and its body, then the service. Every refusal
// is `{ "error": <code> }` with a stable code from `errors.ts`; an unusable body adds
// `"issues": [{ "field", "code" }]`. Every answer is `Cache-Control: no-store`. The start answers 201
// with `created: true` for a new run and 200 with `created: false` for the run that was already there.
import { actorName, type SessionUser } from "../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { MANUAL_REVIEW_ERROR_STATUS, ManualReviewError } from "./errors.ts";
import type { ManualReviewService } from "./service.ts";

/** A question is at most 2000 characters, which is at most 12 KB once escaped; the rest is small. */
export const MANUAL_REVIEW_REQUEST_MAX_BYTES = 16 * 1024;

export type ManualReviewRouteDependencies = {
  /**
   * The signed in user, or a throw that ends the request (`requireUser()` redirects to the login
   * page). Called first, on every request.
   */
  requireUser: () => Promise<SessionUser>;
  service: ManualReviewService;
};

export type ManualReviewRouteHandlers = {
  list(request: Request, repositoryId: string): Promise<Response>;
  start(request: Request, repositoryId: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: ManualReviewError): Response {
  return Response.json(
    {
      error: error.code,
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
    },
    { status: MANUAL_REVIEW_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

async function readBody(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new ManualReviewError(
      "MANUAL_REVIEW_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, MANUAL_REVIEW_REQUEST_MAX_BYTES);
  if (!body.ok)
    throw new ManualReviewError(
      "MANUAL_REVIEW_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  try {
    return JSON.parse(body.text);
  } catch {
    throw new ManualReviewError(
      "MANUAL_REVIEW_REQUEST_INVALID",
      "The body is not valid JSON.",
    );
  }
}

export function createManualReviewRouteHandlers({
  requireUser,
  service,
}: ManualReviewRouteDependencies): ManualReviewRouteHandlers {
  return {
    async list(_request, repositoryId) {
      await requireUser();
      try {
        return Response.json(await service.listOpenPullRequests(repositoryId), {
          headers: NO_STORE,
        });
      } catch (error) {
        if (error instanceof ManualReviewError) return refusal(error);
        throw error;
      }
    },

    async start(request, repositoryId) {
      const user = await requireUser();
      try {
        if (isCrossSite(request))
          throw new ManualReviewError(
            "MANUAL_REVIEW_CROSS_SITE_REQUEST",
            "The request does not come from this site.",
          );
        const started = await service.startReview(
          // The login that is recorded as the one who started the review: the GitHub login, or the
          // email of an account without GitHub.
          { githubLogin: actorName(user) },
          repositoryId,
          await readBody(request),
        );
        return Response.json(started, {
          status: started.created ? 201 : 200,
          headers: NO_STORE,
        });
      } catch (error) {
        if (error instanceof ManualReviewError) return refusal(error);
        throw error;
      }
    },
  };
}
