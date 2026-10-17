// SPDX-License-Identifier: Apache-2.0

// Whether an address can be reached by Paddle from the internet: `https`, no credentials, and a host that is neither a
// loopback, a private, a link-local nor a local name. The notification destination is created with the app's own
// address (`BETTER_AUTH_URL`); an address that fails this would leave a destination that never delivers (or, on the
// live account, one that points at a staging host). Pure: no name is resolved, so a public name that resolves to a
// private address is not caught here (Paddle is the one that connects).
import "server-only";
import { isIPv4 } from "node:net";

/** The four numbers of a dotted IPv4 address (the URL parser has normalized every other form to this one). */
function ipv4Parts(host: string): number[] | null {
  if (!isIPv4(host)) return null;
  return host.split(".").map(Number);
}

function ipv4IsPublic([a = 0, b = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  // Multicast, reserved and broadcast.
  return a < 224;
}

/** `host` is the hostname of a parsed URL: an IPv6 address comes in brackets, in the canonical (compressed, lower case) form. */
function ipv6IsPublic(host: string): boolean {
  const address = host.slice(1, -1);
  if (address === "::" || address === "::1") return false;
  // `::ffff:a.b.c.d` comes out of the URL parser as `::ffff:xxxx:xxxx`.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped !== null) {
    const high = parseInt(mapped[1] ?? "0", 16);
    const low = parseInt(mapped[2] ?? "0", 16);
    return ipv4IsPublic([high >> 8, high & 255, low >> 8, low & 255]);
  }
  // Any other address that starts with `::` is deprecated or reserved.
  if (address.startsWith("::")) return false;
  const first = parseInt(address.split(":")[0] ?? "0", 16);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  return true;
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
