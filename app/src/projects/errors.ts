// The stable error codes of the project service. A caller (the route, a test) branches on `code`,
// never on the message; the UI translates codes to copy.
export const PROJECT_ERROR_CODES = [
  /** The request is not usable: a malformed repository id, or a body that is not `{ "active": boolean }`. */
  "PROJECT_REQUEST_INVALID",
  /** No repository has this id. */
  "PROJECT_REPOSITORY_NOT_FOUND",
  /** The platform no longer lists the repository (removed from the installation); it cannot be activated. */
  "PROJECT_REPOSITORY_UNAVAILABLE",
] as const;
export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

/** The HTTP status each code is answered with. */
export const PROJECT_ERROR_STATUS: Record<ProjectErrorCode, 400 | 404 | 409> = {
  PROJECT_REQUEST_INVALID: 400,
  PROJECT_REPOSITORY_NOT_FOUND: 404,
  PROJECT_REPOSITORY_UNAVAILABLE: 409,
};

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  /** The message names the code's meaning only, never a value from the request. */
  readonly safeMessage = true as const;

  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}
