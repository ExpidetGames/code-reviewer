// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy for the failures every call from a page can run into, whatever the route: the session
// ended, the person is not allowed, the server was not reached, the answer was not what a route
// documents. Shared by the copy of the project list and of the settings form.
import type { TransportErrorCode } from "./json-request.ts";
import { SESSION_ENDED } from "../copy/messages.ts";

export const TRANSPORT_FAILURE_COPY: Record<TransportErrorCode, string> = {
  UNAUTHENTICATED: SESSION_ENDED,
  ACCESS_DENIED: "Your GitHub account is not allowed to use code-review.com.",
  NETWORK_ERROR:
    "The server could not be reached. Check your connection and try again.",
  UNEXPECTED_RESPONSE:
    "The server answered with something unexpected. Reload the page and try again.",
};

/** The sentence for an answer the page cannot read; it names the HTTP status when there is one (a proxy page is a 502, a crash a 500). */
export function unexpectedResponseCopy(status: number | null): string {
  if (status === null || !Number.isInteger(status) || status < 100)
    return TRANSPORT_FAILURE_COPY.UNEXPECTED_RESPONSE;
  return `The server answered with HTTP ${status}. Reload the page and try again.`;
}

export const GENERIC_FAILURE =
  "Something went wrong. Reload the page and try again.";

/**
 * The sentence for a transport code, or undefined when the code is not one of them. With the HTTP status of the answer, an
 * unexpected answer names it.
 */
export function describeTransportFailure(
  code: string,
  status?: number | null,
): string | undefined {
  if (code === "UNEXPECTED_RESPONSE")
    return unexpectedResponseCopy(status ?? null);
  return Object.hasOwn(TRANSPORT_FAILURE_COPY, code)
    ? TRANSPORT_FAILURE_COPY[code as TransportErrorCode]
    : undefined;
}
