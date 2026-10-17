// SPDX-License-Identifier: Apache-2.0

// Paddle's error answer is `{ error: { type, code, detail, errors? }, meta: { request_id } }`. A handler of the
// fake throws a `PaddleHttpError`; the server turns it into that body.

// Error codes. Paddle documents the shape of an error and a few codes (`DOCUMENTED_ERROR_CODES`). Every other code
// the fake answers with was invented for the fake and is UNVERIFIED against the sandbox
// (`UNVERIFIED_ERROR_CODES`): so are the `type` values (`request_error`, `api_error`) and the 403 for a missing key.
// Code that talks to Paddle branches on the HTTP status plus the documented constraint (for example "not within 30
// minutes of renewal"), never on an unverified string, until the sandbox contract run (#448) has checked the names.
// A test (`paddle-fake.integration.test.ts`) fails when the fake answers with a code that is in neither list.
export const DOCUMENTED_ERROR_CODES = [
  "not_found",
  "invalid_field",
  "forbidden",
] as const;

export const UNVERIFIED_ERROR_CODES = [
  "entity_archived",
  "invalid_request",
  "request_too_large",
  "method_not_allowed",
  "authentication_missing",
  "internal_error",
  "injected_fault",
  "too_many_requests",
  "transaction_already_completed",
  "subscription_update_when_canceled",
  "subscription_update_when_past_due",
  "subscription_locked_pending_changes",
  "subscription_locked_renewal",
  // Not Paddle's at all: the app's own policy (the client refuses a PATCH of a money field), listed so that no
  // test or caller mistakes it for a Paddle answer. The fake never answers with it (`app/src/billing`).
  "price_field_immutable",
] as const;

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
