// The handler behind `PUT /api/repositories/:repositoryId/project`, with its collaborators passed in
// so the route file only wires the real ones and tests wire fakes. The body is `{ "active": true }`
// to activate and `{ "active": false }` to deactivate; both are idempotent.
//
// Order: the user first (nothing is read or looked at before the caller is known), then where the
// request comes from, its content type and its body, then the service. Every refusal is
// `{ "error": <code> }` with a stable code from `errors.ts`.
import type { SessionUser } from "../auth/access-policy.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import {
  PROJECT_ERROR_STATUS,
  ProjectError,
  type ProjectErrorCode,
} from "./errors.ts";
import type { ProjectService } from "./service.ts";

/** The body is one small object. */
export const PROJECT_REQUEST_MAX_BYTES = 1024;

export type ProjectRouteDependencies = {
  /**
   * The signed in user, or a throw that ends the request (`requireUser()` redirects to the login
   * page). Called first, on every request.
   */
  requireUser: () => Promise<SessionUser>;
  service: ProjectService;
};

export type ProjectRouteHandler = (
  request: Request,
  repositoryId: string,
) => Promise<Response>;

const NO_STORE = { "cache-control": "no-store" };

function refusal(code: ProjectErrorCode): Response {
  return Response.json(
    { error: code },
    { status: PROJECT_ERROR_STATUS[code], headers: NO_STORE },
  );
}

// Defense in depth for a session cookie that is `SameSite=Lax` already. Browsers say where a request
// comes from in `Sec-Fetch-Site`; only `same-origin` (and `none`, a request the user typed) is let
// through, so even a sibling subdomain (`same-site`) is refused. A browser that does not send it is
// judged by `Origin` against the host the request was addressed to. A client that sends neither (curl,
// a script) is no browser and can only act with a cookie it already holds.
function isCrossSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null)
    return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // "null" or garbage
  }
}

// A cross-site form can send `text/plain` or form encoded bodies without a preflight, but not
// `application/json`, so insisting on it is a second layer against another site switching a project
// with the user's cookie.
function isJson(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(type);
}

/** `true` or `false` for a body `{ "active": boolean }`; throws the `ProjectError` to answer with. */
async function readActive(request: Request): Promise<boolean> {
  if (!isJson(request))
    throw new ProjectError(
      "PROJECT_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, PROJECT_REQUEST_MAX_BYTES);
  if (!body.ok)
    throw new ProjectError(
      "PROJECT_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  const invalid = () =>
    new ProjectError(
      "PROJECT_REQUEST_INVALID",
      'The body must be {"active": true} or {"active": false}.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw invalid();
  const active = (parsed as { active?: unknown }).active;
  if (typeof active !== "boolean") throw invalid();
  return active;
}

export function createProjectRouteHandler({
  requireUser,
  service,
}: ProjectRouteDependencies): ProjectRouteHandler {
  return async function handle(request, repositoryId) {
    await requireUser();

    try {
      if (isCrossSite(request))
        throw new ProjectError(
          "PROJECT_CROSS_SITE_REQUEST",
          "The request does not come from this site.",
        );
      const active = await readActive(request);
      if (active) {
        const { project, outcome } =
          await service.activateProject(repositoryId);
        return Response.json(
          {
            repositoryId: project.repositoryId,
            projectId: project.id,
            active: true,
            changed: outcome !== "unchanged",
          },
          { headers: NO_STORE },
        );
      }
      const { project, changed } =
        await service.deactivateProject(repositoryId);
      return Response.json(
        {
          repositoryId,
          projectId: project?.id ?? null,
          active: false,
          changed,
        },
        { headers: NO_STORE },
      );
    } catch (error) {
      if (error instanceof ProjectError) return refusal(error.code);
      throw error;
    }
  };
}
