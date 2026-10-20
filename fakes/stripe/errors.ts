// SPDX-License-Identifier: Apache-2.0

// Stripe's error answer is `{ error: { type, message, code?, param?, doc_url? } }`. A handler of the fake throws a
// `StripeHttpError`; the server turns it into that body. The messages copy the ones the sandbox gave (2026-10-20) where
// they were observed: a missing parameter, an unknown object, the idempotency error, `payment_method_types` and
// `custom_text` on Managed Payments, a missing product tax code. The others are written in the same style and are not
// verified.

export type StripeErrorBody = {
  error: {
    type: string;
    message: string;
    code?: string;
    param?: string;
    doc_url?: string;
  };
};

export class StripeHttpError extends Error {
  readonly status: number;
  readonly body: StripeErrorBody;

  constructor(
    status: number,
    type: string,
    message: string,
    extra: { code?: string; param?: string } = {},
  ) {
    super(message);
    this.status = status;
    this.body = {
      error: {
        type,
        message,
        ...(extra.code === undefined ? {} : { code: extra.code }),
        ...(extra.param === undefined ? {} : { param: extra.param }),
        ...(extra.code === undefined
          ? {}
          : {
              doc_url: `https://stripe.com/docs/error-codes/${extra.code.replaceAll("_", "-")}`,
            }),
      },
    };
  }
}

export const invalidRequest = (
  message: string,
  extra: { code?: string; param?: string } = {},
) => new StripeHttpError(400, "invalid_request_error", message, extra);

export const missingParam = (name: string) =>
  invalidRequest(`Missing required param: ${name}.`, {
    code: "parameter_missing",
    param: name,
  });

export const invalidParam = (name: string, why: string) =>
  invalidRequest(`Invalid ${name}: ${why}`, {
    code: "parameter_invalid_empty",
    param: name,
  });

export const unknownParam = (name: string) =>
  invalidRequest(`Received unknown parameter: ${name}`, { param: name });

/** `No such customer: 'cus_x'`: a 404 for the object asked for, a 400 for one named in a parameter. */
export const noSuch = (
  kind: string,
  id: string,
  param: string,
  status: 400 | 404 = 404,
) =>
  new StripeHttpError(
    status,
    "invalid_request_error",
    `No such ${kind}: '${id}'`,
    {
      code: "resource_missing",
      param,
    },
  );
