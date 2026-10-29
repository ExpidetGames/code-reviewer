// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy for the failures every call from a page can run into, whatever the route: the session
// ended, the person is not allowed, the server was not reached, the answer was not what a route
// documents. Shared by the copy of the project list and of the settings form.
import type { ProductIdentity } from "../product-identity/identity.ts";
import type { TransportErrorCode } from "./json-request.ts";
import { SESSION_ENDED } from "../copy/messages.ts";

/** The sentence for an answer the page cannot read, when the status is not known. */
export const UNEXPECTED_RESPONSE_COPY =
  "The server answered with something unexpected. Reload the page and try again.";

/** The sentence for each transport failure, for the product the page belongs to (the access sentence names it). */
export const transportFailureCopy = (
  product: ProductIdentity,
): Record<TransportErrorCode, string> => ({
  UNAUTHENTICATED: SESSION_ENDED,
  ACCESS_DENIED: `Your GitHub account is not allowed to use ${product.name}.`,
  NETWORK_ERROR:
    "The server could not be reached. Check your connection and try again.",
  UNEXPECTED_RESPONSE: UNEXPECTED_RESPONSE_COPY,
});

/** The sentence for an answer the page cannot read; it names the HTTP status when there is one (a proxy page is a 502, a crash a 500). */
export function unexpectedResponseCopy(status: number | null): string {
  if (status === null || !Number.isInteger(status) || status < 100)
    return UNEXPECTED_RESPONSE_COPY;
  return `The server answered with HTTP ${status}. Reload the page and try again.`;
}

export const GENERIC_FAILURE =
  "Something went wrong. Reload the page and try again.";

/**
 * The sentence for a transport code, or undefined when the code is not one of them. With the HTTP status of the answer, an
 * unexpected answer names it.
 */
export function describeTransportFailure(
  product: ProductIdentity,
  code: string,
  status?: number | null,
): string | undefined {
  if (code === "UNEXPECTED_RESPONSE")
    return unexpectedResponseCopy(status ?? null);
  const copy = transportFailureCopy(product);
  return Object.hasOwn(copy, code)
    ? copy[code as TransportErrorCode]
    : undefined;
}
