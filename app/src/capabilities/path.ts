// SPDX-License-Identifier: LicenseRef-Proprietary

// A request path the way the router reads it. Shared by the admin portal's path rules (src/admin/paths.ts) and the capability
// table (routes.ts), which import nothing from each other.

/** The path as the router sees it, or null when it cannot be decoded. */
export function normalizePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
