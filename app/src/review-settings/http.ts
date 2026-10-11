// SPDX-License-Identifier: Apache-2.0

// The handlers behind the review settings routes, with their collaborators passed in so the route
// files only wire the real ones and tests wire fakes:
//
//   GET|PUT                /api/review-settings                                 the global defaults
//   GET|PUT|DELETE         /api/repositories/:repositoryId/project/settings    the overrides of a project
//
// The body of a PUT is `{ "settings": { ...some of the fields } }`; it replaces the whole set of the
// layer (a field left out is inherited again). DELETE removes every override of a project.
//
// Order: the user first (nothing is read or looked at before the caller is known), then, for a change,
// where the request comes from, its content type and its body, then the service. Every refusal is
// `{ "error": <code> }` with a stable code from `errors.ts`; an invalid setting adds
// `"issues": [{ "field", "code" }]`. Every answer is `Cache-Control: no-store`.
import { actorName, type SessionUser } from "../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { REVIEW_SETTINGS_ERROR_STATUS, ReviewSettingsError } from "./errors.ts";
import type { ReviewSettingsService } from "./service.ts";
import { REVIEW_SETTING_LIMITS } from "./settings.ts";

/** The longest possible project rules are 4000 characters, which is at most 24 KB once escaped. */
export const REVIEW_SETTINGS_REQUEST_MAX_BYTES = 64 * 1024;

export type ReviewSettingsRouteDependencies = {
  /**
   * The signed in user, or a throw that ends the request (`requireUser()` redirects to the login
   * page). Called first, on every request.
   */
  requireUser: () => Promise<SessionUser>;
  service: ReviewSettingsService;
};

export type ReviewSettingsRouteHandlers = {
  getGlobal(request: Request): Promise<Response>;
  putGlobal(request: Request): Promise<Response>;
  getProject(request: Request, repositoryId: string): Promise<Response>;
  putProject(request: Request, repositoryId: string): Promise<Response>;
  deleteProject(request: Request, repositoryId: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: ReviewSettingsError): Response {
  return Response.json(
    {
      error: error.code,
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
    },
    { status: REVIEW_SETTINGS_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

function ok(view: object): Response {
  // The limits ride along so a form can show them without hard-coding the numbers.
  return Response.json(
    { ...view, limits: REVIEW_SETTING_LIMITS },
    { headers: NO_STORE },
  );
}

function checkSite(request: Request): void {
  if (isCrossSite(request))
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_CROSS_SITE_REQUEST",
      "The request does not come from this site.",
    );
}

/** The `settings` object of a body `{ "settings": {...} }`; its fields are checked by the service. */
async function readSettings(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(
    request,
    REVIEW_SETTINGS_REQUEST_MAX_BYTES,
  );
  if (!body.ok)
    throw new ReviewSettingsError(
      "REVIEW_SETTINGS_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  const invalid = () =>
    new ReviewSettingsError(
      "REVIEW_SETTINGS_REQUEST_INVALID",
      'The body must be {"settings": {...}}.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    throw invalid();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.hasOwn(parsed, "settings")
  )
    throw invalid();
  return (parsed as { settings: unknown }).settings;
}

export function createReviewSettingsRouteHandlers({
  requireUser,
  service,
}: ReviewSettingsRouteDependencies): ReviewSettingsRouteHandlers {
  // Runs a handler body after the user is known; a ReviewSettingsError becomes its answer.
  async function guarded(
    run: (user: SessionUser) => Promise<Response>,
  ): Promise<Response> {
    const user = await requireUser();
    try {
      return await run(user);
    } catch (error) {
      if (error instanceof ReviewSettingsError) return refusal(error);
      throw error;
    }
  }

  return {
    getGlobal: () => guarded(async () => ok(await service.getGlobalSettings())),

    putGlobal: (request) =>
      guarded(async (user) => {
        checkSite(request);
        const settings = await readSettings(request);
        return ok(
          await service.updateGlobalSettings(settings, actorName(user)),
        );
      }),

    getProject: (_request, repositoryId) =>
      guarded(async () => ok(await service.getProjectSettings(repositoryId))),

    putProject: (request, repositoryId) =>
      guarded(async () => {
        checkSite(request);
        const settings = await readSettings(request);
        return ok(await service.updateProjectSettings(repositoryId, settings));
      }),

    deleteProject: (request, repositoryId) =>
      guarded(async () => {
        checkSite(request);
        return ok(await service.resetProjectSettings(repositoryId));
      }),
  };
}
