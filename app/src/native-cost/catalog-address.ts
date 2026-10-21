// SPDX-License-Identifier: Apache-2.0

// The address the own key of a catalog provider may be sent to (#555, needs a security review).
//
// A provider outside the app's registry has no address of its own in the code: the claim sends the one the catalog TRUSTS for it
// (`models-dev/upstream-url.ts`, #548: https, a public host, the first safe address seen, a change blocks the provider until
// an admin confirms it) and never one a workspace typed. The runner cannot see that trust record, so it judges what it can
// (`runner/.../passthrough/destination.py`): a plain public https address in exactly one spelling. This module is the same
// judgement on this side, applied to the stored address before an entry is built from it, so a damaged or hand-edited row ends
// the job here with a clear code and not later in the runner. `contracts/key-destination-vectors.json` holds both sides to the
// same verdicts. No name is resolved here: the connection judges every address a name resolves to.
import "server-only";
import { normalizedAddress, isPublicHttpsUrl } from "../billing/public-url.ts";
import { UPSTREAM_BASE_URL } from "../models-dev/upstream-url.ts";

// A plain path: segments of letters, digits and . _ ~ - only (no empty segment, no escape, no query).
const PATH = /^(\/[A-Za-z0-9._~-]+)*$/;
const NAME =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NUMBERS = /^[0-9.]+$/;

/** Whether `address` is a plain public https address in the one spelling the app writes it (`normalizedAddress` of itself). */
export function isCanonicalCatalogAddress(address: string): boolean {
  if (!UPSTREAM_BASE_URL.test(address) || address.includes("\\")) return false;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "" || url.search !== "" || url.hash !== "") return false;
  // The spelling: lower-case name, no default port, no trailing slash, no dot segment, no doubled slash.
  if (normalizedAddress(address) !== address) return false;
  const path = address.slice(url.origin.length);
  if (path !== "" && !PATH.test(path)) return false;
  if (path.split("/").some((segment) => segment === "." || segment === ".."))
    return false;
  if (!isPublicHttpsUrl(address)) return false;
  const host = url.hostname;
  // A catalog provider has a name: an IP literal of any kind (IPv4 or bracketed IPv6, mapped, with a zone id, in a number
  // spelling) is refused on both sides, so neither has to agree on which literals count as public (#555).
  if (host.startsWith("[") || NUMBERS.test(host)) return false;
  const top = host.slice(host.lastIndexOf(".") + 1);
  return NAME.test(host) && /[a-z]/.test(top) && !top.startsWith("0x");
}
