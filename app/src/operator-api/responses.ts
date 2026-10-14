// SPDX-License-Identifier: Apache-2.0

// Every answer of the operator API is built here: JSON, `Cache-Control: no-store`, the version in the body, and
// errors as `{ version, error: <code> }` (plus `field` for a refused entitlement field). There is no message
// text: callers branch on the code, and nothing of the request is echoed back.
import { OPERATOR_API_VERSION, type OperatorApiErrorCode } from "./contract.ts";

const BASE_HEADERS = { "Cache-Control": "no-store" } as const;

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { version: OPERATOR_API_VERSION, ...body },
    { status, headers: { ...BASE_HEADERS, ...headers } },
  );
}

export function errorResponse(
  status: number,
  code: OperatorApiErrorCode,
  extra: { field?: string; headers?: Record<string, string> } = {},
): Response {
  return jsonResponse(
    status,
    {
      error: code,
      ...(extra.field === undefined ? {} : { field: extra.field }),
    },
    extra.headers,
  );
}

/** The one answer to a missing, non-bearer or wrong credential, whatever the reason. */
export function unauthorized(): Response {
  return errorResponse(401, "unauthorized", {
    headers: { "WWW-Authenticate": "Bearer" },
  });
}
