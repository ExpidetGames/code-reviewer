// SPDX-License-Identifier: Apache-2.0

// Sends a key only to an address that is public at the moment of the connection (#548, #550, #555). The check made when
// the catalog is stored (`checkUpstreamUrl`) is a verdict of one moment: a name can resolve elsewhere a minute later (DNS
// rebinding, or a record the provider changes). So whoever sends a real key from this server resolves the name itself,
// refuses the connection when any address is not public, and hands the connect the addresses it vetted, so what was
// checked is what is connected to. `createGuardedLookup` is the `lookup` option of `node:https` (and `node:net`);
// `createGuardedFetch` is a `fetch` for the requests that carry a key (the key test of the generic adapter) built on it.
// It answers a status only, never follows a redirect and never reads a body. The supervisor of #550 uses the same lookup
// for the connection to the provider.
import "server-only";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress, isPublicHttpsUrl } from "../billing/public-url.ts";
import type { FetchLike } from "./fetch.ts";

/** The `code` of the error of a connection the guard refused. */
export const CONNECT_GUARD_BLOCKED = "CONNECT_GUARD_BLOCKED" as const;

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

/** Every address of the name, as the connect would see them. */
export const resolveAddresses: AddressResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function blocked(why: string): NodeJS.ErrnoException {
  // No address and no name in the text: it ends up in logs.
  return Object.assign(new Error(`Connection refused by the guard: ${why}.`), {
    code: CONNECT_GUARD_BLOCKED,
  });
}

/** A `lookup` that refuses a name when any of its addresses is not public, and connects only to what it resolved. */
export function createGuardedLookup(
  resolve: AddressResolver = resolveAddresses,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        // One private address is enough to refuse: the connection may pick any of them.
        if (
          addresses.length === 0 ||
          !addresses.every((entry) => isPublicAddress(entry.address))
        )
          return callback(
            blocked("the name does not resolve to a public address"),
            [],
          );
        if (options.all === true) return callback(null, addresses);
        const [first] = addresses as [LookupAddress];
        return callback(null, first.address, first.family);
      },
      (error: unknown) =>
        callback(
          error instanceof Error
            ? error
            : new Error("The name could not be resolved."),
          [],
        ),
    );
  };
}

type ResponseLike = { statusCode?: number; resume(): void };
type RequestHandle = {
  on(event: "error", listener: (error: Error) => void): unknown;
  end(): void;
};
export type HttpsRequest = (
  url: URL,
  options: {
    method: string;
    headers: Record<string, string>;
    lookup: LookupFunction;
    signal?: AbortSignal;
  },
  onResponse: (response: ResponseLike) => void,
) => RequestHandle;

type Dependencies = {
  lookup?: LookupFunction;
  request?: HttpsRequest;
};

/** A `fetch` for requests that carry a key: https on port 443 to a public address only, checked at the connection. */
export function createGuardedFetch({
  lookup = createGuardedLookup(),
  request = httpsRequest,
}: Dependencies = {}): FetchLike {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        return reject(blocked("the address is not a URL"));
      }
      // The literal and the name are judged before a lookup is made; a name is resolved by the lookup at the connection.
      if (
        url.protocol !== "https:" ||
        url.port !== "" ||
        !isPublicHttpsUrl(input)
      )
        return reject(blocked("the address is not a public https address"));
      const req = request(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          lookup,
          ...(init.signal == null ? {} : { signal: init.signal }),
        },
        (response) => {
          // The body is never read; the status is the answer.
          response.resume();
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 599)
            return reject(new Error("The answer has no usable status."));
          resolve(new Response(null, { status }));
        },
      );
      req.on("error", reject);
      req.end();
    });
}
