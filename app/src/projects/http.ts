// The handler behind `PUT /api/repositories/:repositoryId/project`, with its collaborators passed in
// so the route file only wires the real ones and tests wire fakes. The body is `{ "active": true }`
// to activate and `{ "active": false }` to deactivate; both are idempotent.
//
// Order: the user first (nothing is read or looked at before the caller is known), then the request,
// then the service. Every refusal is `{ "error": <code> }` with a stable code from `errors.ts`.
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

// A cross-site form can send `text/plain` or form encoded bodies without a preflight, but not
// `application/json`, so insisting on it is what keeps another site from switching a project with the
// user's cookie.
function isJson(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(type);
}

/** `true` or `false` for a body `{ "active": boolean }`, undefined for anything else. */
async function readActive(request: Request): Promise<boolean | undefined> {
  if (!isJson(request)) return undefined;
  const body = await readLimitedBody(request, PROJECT_REQUEST_MAX_BYTES);
  if (!body.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;
  const active = (parsed as { active?: unknown }).active;
  return typeof active === "boolean" ? active : undefined;
}

export function createProjectRouteHandler({
  requireUser,
  service,
}: ProjectRouteDependencies): ProjectRouteHandler {
  return async function handle(request, repositoryId) {
    await requireUser();

    const active = await readActive(request);
    if (active === undefined) return refusal("PROJECT_REQUEST_INVALID");

    try {
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
