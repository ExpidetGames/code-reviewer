// SPDX-License-Identifier: LicenseRef-Proprietary

// The address models.dev states for a provider (`api`) decides where a real key is sent, so it is untrusted data too
// (#548, part C). Three rules, and the state they keep per provider:
//
// 1. **The address must be safe** (`checkUpstreamUrl`): https on port 443 only, no credentials, no query, in the form the
//    job entry accepts (`UPSTREAM_BASE_URL`), and neither a private, loopback, link-local or other special-purpose
//    address (`billing/public-url.ts`: NAT64, 6to4, the IANA registry) nor a name that resolves to one. The name is
//    resolved here, when the catalog is stored, which is a verdict of one moment: whoever sends the key must check the
//    address it connects to on every connection (`connect-guard.ts`, #550), because a name can change what it resolves
//    to afterwards.
// 2. **Trust on first use** (`nextUrlState`): the first safe address seen for a provider is the trusted one.
// 3. **A change blocks** the provider, for the managed key and for an own key, until an admin confirms the new address
//    (the portal for that is #554; this module is the data and the block). Going back to the trusted address unblocks.
//
// A provider is usable only while its state is `trusted` (`isUsable`). Pure but for the injected resolver.
import "server-only";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import {
  isPublicAddress,
  isPublicHttpsUrl,
  normalizedAddress,
} from "../billing/public-url.ts";

/** The longest address looked at; models.dev addresses are far shorter. */
export const MAX_URL_LENGTH = 2048;
/**
 * What an upstream address must look like to go into a job entry (`job-entry.ts` and `contracts/job-model-entry.v1.json`
 * use this text): https, then no whitespace, `?`, `#` or `@` anywhere. Checked when the address is stored too, so that a
 * trusted address is never one the entry would refuse later.
 */
export const UPSTREAM_BASE_URL = /^https:\/\/[^\s?#@]+$/;
const HOST_NAME =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
/** How much of a refused address is kept for the admin to read. */
const SEEN_LENGTH = 512;

export const URL_PROBLEMS = [
  "invalid_url",
  "too_long",
  "not_https",
  "credentials_in_url",
  /** A port other than 443: a key is not sent to a service that is no API (SSH, a database, an admin port). */
  "port_not_allowed",
  "private_address",
  /** The name did not resolve (or resolved to nothing): inconclusive, not a verdict on the address. */
  "unresolvable",
  /** models.dev states no address and the SDK has no default. */
  "missing",
] as const;
export type UrlProblem = (typeof URL_PROBLEMS)[number];

export const URL_STATES = ["trusted", "url_changed", "rejected"] as const;
export type UrlState = (typeof URL_STATES)[number];

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; problem: UrlProblem; seen: string | null };

export type HostResolver = (hostname: string) => Promise<string[]>;

/** The resolver of the running server: every address of the name, with a short time limit. */
export const dnsResolver: HostResolver = async (hostname) => {
  const addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("dns timeout")), 5000).unref(),
    ),
  ]);
  return addresses.map((entry) => entry.address);
};

function refused(problem: UrlProblem, candidate: string): UrlCheck {
  return { ok: false, problem, seen: candidate.slice(0, SEEN_LENGTH) };
}

/** Judges one candidate address. `null` is "models.dev states none". Never throws. */
export async function checkUpstreamUrl(
  candidate: string | null,
  resolve: HostResolver = dnsResolver,
): Promise<UrlCheck> {
  if (candidate === null) return { ok: false, problem: "missing", seen: null };
  if (candidate.length > MAX_URL_LENGTH) return refused("too_long", candidate);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return refused("invalid_url", candidate);
  }
  if (url.protocol !== "https:") return refused("not_https", candidate);
  if (url.username !== "" || url.password !== "")
    return refused("credentials_in_url", candidate);
  if (url.search !== "" || url.hash !== "")
    return refused("invalid_url", candidate);
  // `port` is empty for the default port of https, however it was written (`:443`, `:0443`).
  if (url.port !== "") return refused("port_not_allowed", candidate);
  const normalized = normalizedAddress(candidate);
  if (!UPSTREAM_BASE_URL.test(normalized))
    return refused("invalid_url", candidate);
  // Loopback, private and link-local literals, `localhost`, `.local`, `.internal` and single-label names.
  if (!isPublicHttpsUrl(candidate))
    return refused("private_address", candidate);
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIPv4(literal) && !isIPv6(literal)) {
    // The URL parser lets `${TENANT}` through in a host; a real name is letters, digits and hyphens in labels.
    if (!HOST_NAME.test(url.hostname.replace(/\.$/, "")))
      return refused("invalid_url", candidate);
    let addresses: string[];
    try {
      addresses = await resolve(url.hostname.replace(/\.$/, ""));
    } catch {
      return refused("unresolvable", candidate);
    }
    if (addresses.length === 0) return refused("unresolvable", candidate);
    // One private address is enough to refuse: the connection may pick any of them.
    if (!addresses.every(isPublicAddress))
      return refused("private_address", candidate);
  }
  return { ok: true, url: normalized };
}

/** What is stored per provider about its address. */
export type UrlRecord = {
  state: UrlState;
  /** The address the first check passed (and an admin confirmed later); null until there is one. */
  trustedUrl: string | null;
  /** The address (or, for a refused one, the text) that differs from the trusted one and waits for an admin. */
  pendingUrl: string | null;
  problem: UrlProblem | null;
};

/** Only a provider whose address is trusted and not blocked may be used for a job. */
export function isUsable(record: UrlRecord): boolean {
  return record.state === "trusted" && record.trustedUrl !== null;
}

/** The state after today's check of the address models.dev states. `previous` is undefined for a provider seen first. */
export function nextUrlState(
  previous: UrlRecord | undefined,
  check: UrlCheck,
): UrlRecord {
  const trustedUrl = previous?.trustedUrl ?? null;
  if (check.ok) {
    if (trustedUrl === null || check.url === trustedUrl)
      return {
        state: "trusted",
        trustedUrl: check.url,
        pendingUrl: null,
        problem: null,
      };
    return {
      state: "url_changed",
      trustedUrl,
      pendingUrl: check.url,
      problem: null,
    };
  }
  // A name that does not resolve says nothing about the address: an address that was trusted stays as it is.
  if (
    check.problem === "unresolvable" &&
    previous !== undefined &&
    trustedUrl !== null
  )
    return previous;
  if (trustedUrl === null)
    return {
      state: "rejected",
      trustedUrl: null,
      pendingUrl: check.seen,
      problem: check.problem,
    };
  return {
    state: "url_changed",
    trustedUrl,
    pendingUrl: check.seen,
    problem: check.problem,
  };
}
