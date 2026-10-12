// SPDX-License-Identifier: Apache-2.0

// The copy for the failures every call from a page can run into, whatever the route: the session
// ended, the person is not allowed, the server was not reached, the answer was not what a route
// documents. Shared by the copy of the project list and of the settings form.
import type { TransportErrorCode } from "./json-request.ts";
import { SESSION_ENDED } from "../copy/messages.ts";

export const TRANSPORT_FAILURE_COPY: Record<TransportErrorCode, string> = {
  UNAUTHENTICATED: SESSION_ENDED,
  ACCESS_DENIED:
    "Your GitHub account is not allowed to use this Code Reviewer instance.",
  NETWORK_ERROR:
    "The server could not be reached. Check your connection and try again.",
  UNEXPECTED_RESPONSE:
    "The server answered with something unexpected. Reload the page and try again.",
};

export const GENERIC_FAILURE =
  "Something went wrong. Reload the page and try again.";

/** The sentence for a transport code, or undefined when the code is not one of them. */
export function describeTransportFailure(code: string): string | undefined {
  return Object.hasOwn(TRANSPORT_FAILURE_COPY, code)
    ? TRANSPORT_FAILURE_COPY[code as TransportErrorCode]
    : undefined;
}
