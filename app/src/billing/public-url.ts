// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether an address can be reached by Stripe from the internet: `https`, no credentials, and a host that is neither a
// loopback, a private, a link-local nor a local name. A webhook endpoint is registered with the app's own address
// (`BETTER_AUTH_URL`); an address that fails this would leave an endpoint that never delivers (or, on the live account,
// one that points at a staging host). Pure: no name is resolved, so a public name that resolves to a private address
// is not caught here (Stripe is the one that connects).
import "server-only";
import { isIPv4, isIPv6 } from "node:net";

/** The four numbers of a dotted IPv4 address (the URL parser has normalized every other form to this one). */
function ipv4Parts(host: string): number[] | null {
  if (!isIPv4(host)) return null;
  return host.split(".").map(Number);
}

/** Not public: the IANA special-purpose registry (RFC 6890 and its updates) minus what is globally reachable. */
function ipv4IsPublic([a = 0, b = 0, c = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  // 192.0.0.0/24 protocol assignments (DS-Lite, NAT64 discovery, ...), the documentation blocks TEST-NET-1/2/3 and the
  // deprecated 6to4 relay anycast.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  // 198.18.0.0/15 benchmarking.
  if (a === 198 && (b === 18 || b === 19)) return false;
  // Multicast, reserved and broadcast.
  return a < 224;
}

/** The eight 16-bit groups of an IPv6 address in the canonical form of the URL parser; null for anything else. */
function ipv6Groups(address: string): number[] | null {
  const parts = address.split("::");
  if (parts.length > 2) return null;
  const read = (text: string | undefined): number[] =>
    text === undefined || text === ""
      ? []
      : text.split(":").map((group) => parseInt(group, 16));
  const head = read(parts[0]);
  const tail = read(parts[1]);
  const fill = 8 - head.length - tail.length;
  if (parts.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [
    ...head,
    ...new Array<number>(Math.max(fill, 0)).fill(0),
    ...tail,
  ];
  return groups.every((group) => Number.isInteger(group) && group <= 0xffff)
    ? groups
    : null;
}

/** The IPv4 address in two 16-bit groups. */
const embedded = (high = 0, low = 0): number[] => [
  high >> 8,
  high & 255,
  low >> 8,
  low & 255,
];

/**
 * `host` is the hostname of a parsed URL: an IPv6 address comes in brackets, in the canonical (compressed, lower case)
 * form. Addresses that carry an IPv4 address (mapped, NAT64, 6to4) are public only when that address is.
 */
function ipv6IsPublic(host: string): boolean {
  const groups = ipv6Groups(host.slice(1, -1));
  if (groups === null) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] =
    groups;
  if (g0 === 0x64 && g1 === 0xff9b) {
    // 64:ff9b::/96 NAT64 (RFC 6052) reaches the IPv4 address in the last 32 bits; 64:ff9b:1::/48 is local use (RFC 8215).
    const wellKnown = g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
    return wellKnown && ipv4IsPublic(embedded(g6, g7));
  }
  // ::/8 is reserved: the unspecified address, the loopback, the deprecated IPv4-compatible and translated forms. The one
  // use is the IPv4-mapped `::ffff:a.b.c.d`.
  if (g0 >> 8 === 0) {
    const zeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    return zeros && g5 === 0xffff && ipv4IsPublic(embedded(g6, g7));
  }
  // 6to4 (RFC 3056): the IPv4 address is in bits 16 to 47.
  if (g0 === 0x2002) return ipv4IsPublic(embedded(g1, g2));
  // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID, ...) and 2001:db8::/32 documentation.
  if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return false;
  // 3fff::/20 documentation (RFC 9637).
  if (g0 === 0x3fff && g1 < 0x1000) return false;
  // 100::/64 discard-only, 5f00::/16 segment routing SIDs (RFC 9602).
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false;
  if (g0 === 0x5f00) return false;
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local (deprecated), ff00::/8 multicast.
  if ((g0 & 0xfe00) === 0xfc00) return false;
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return false;
  if ((g0 & 0xff00) === 0xff00) return false;
  return true;
}

/**
 * Whether a resolved address (`93.184.216.34`, `::1`, `::ffff:7f00:1`, no brackets) is one the internet can reach: not
 * loopback, private, link-local, unique-local, multicast or reserved. Text that is no IP address is not public.
 */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return ipv4IsPublic(address.split(".").map(Number));
  if (!isIPv6(address)) return false;
  try {
    // The URL parser writes an IPv6 address in the canonical form that `ipv6IsPublic` reads.
    return ipv6IsPublic(new URL(`https://[${address}]/`).hostname);
  } catch {
    return false;
  }
}

export function isPublicHttpsUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return false;
  if (host.startsWith("[")) return ipv6IsPublic(host);
  const parts = ipv4Parts(host);
  if (parts !== null) return ipv4IsPublic(parts);
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  // A name with one label (`intranet`) is only known on a private network.
  return host.includes(".");
}

/**
 * An address in one spelling, to compare two that name the same place: lower-case host, no default port, no trailing
 * slash, no query or fragment. Text that is no URL is only trimmed of trailing slashes.
 */
export function normalizedAddress(text: string): string {
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return text.replace(/\/+$/, "");
  }
}
