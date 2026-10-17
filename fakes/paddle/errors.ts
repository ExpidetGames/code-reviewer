// SPDX-License-Identifier: Apache-2.0

// Paddle's error answer is `{ error: { type, code, detail, errors? }, meta: { request_id } }`. A handler of the
// fake throws a `PaddleHttpError`; the server turns it into that body.

export type FieldError = { field: string; message: string };

export class PaddleHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly fieldErrors: FieldError[] | undefined;

  constructor(
    status: number,
    code: string,
    detail: string,
    fieldErrors?: FieldError[],
  ) {
    super(detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.fieldErrors = fieldErrors;
  }
}

export const notFound = (what: string) =>
  new PaddleHttpError(404, "not_found", `Entity ${what} not found`);

export const conflict = (code: string, detail: string) =>
  new PaddleHttpError(409, code, detail);

export const invalidFields = (errors: FieldError[]) =>
  new PaddleHttpError(
    400,
    "invalid_field",
    "Invalid request. Check the errors field for more details.",
    errors,
  );

export function errorBody(
  status: number,
  code: string,
  detail: string,
  requestId: string,
  fieldErrors?: FieldError[],
) {
  return {
    error: {
      type: status >= 500 ? "api_error" : "request_error",
      code,
      detail,
      ...(fieldErrors === undefined ? {} : { errors: fieldErrors }),
    },
    meta: { request_id: requestId },
  };
}
