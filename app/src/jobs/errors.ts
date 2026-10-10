// Stable error codes of the job queue. Callers branch on `code`, never on the message.
export const JOB_ERROR_CODE_SET = [
  /** `enqueue` was given a value that is not valid; `fieldErrors` names the fields. */
  "JOB_INPUT_INVALID",
  /** A trigger names a repository the app has no row for (yet). */
  "JOB_REPOSITORY_UNKNOWN",
] as const;
export type JobQueueErrorCode = (typeof JOB_ERROR_CODE_SET)[number];

/** Why one field was refused. */
export const JOB_FIELD_ERROR_CODES = [
  "required",
  "invalid",
  "too_long",
] as const;
export type JobFieldErrorCode = (typeof JOB_FIELD_ERROR_CODES)[number];

export type JobFieldError = { field: string; code: JobFieldErrorCode };

export class JobQueueError extends Error {
  readonly code: JobQueueErrorCode;
  readonly fieldErrors: JobFieldError[];

  constructor(
    code: JobQueueErrorCode,
    message: string,
    options: { fieldErrors?: JobFieldError[]; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "JobQueueError";
    this.code = code;
    this.fieldErrors = options.fieldErrors ?? [];
  }
}
