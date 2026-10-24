// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the proxy matcher: it must match every path except Next.js's own static files, because
// "default deny" only holds for paths the proxy sees. A path missing from the match is open.
import { describe, expect, it } from "vitest";
import { PROXY_SKIPPED_PATHS } from "./admin/paths.ts";
import { config } from "./proxy.ts";

// Next.js compiles a matcher with path-to-regexp; for this pattern (a negative lookahead in one
// group) the source is a plain regular expression anchored at both ends.
const [source] = config.matcher;
const matcher = new RegExp(`^${source}$`);

describe("the proxy matcher", () => {
  it.each([
    "/",
    "/login",
    "/api/jobs",
    "/api/health",
    "/api/auth/callback/github",
    "/projects/42",
    "/robots.txt",
    "/_next",
    "/_nextfoo/x",
    "/_next/imagefoo",
    "/_next/static",
    "/favicon.icoo",
    "/x/favicon.ico",
    "/icon.svgx",
    "/x/icon.svg",
    "/apple-icon.pngx",
    "/x/apple-icon.png",
    "/_next/data/build/x.json",
  ])("sees %s", (pathname) => {
    expect(matcher.test(pathname)).toBe(true);
  });

  // #650-T01
  it.each([
    "/_next/static/chunks/a.js",
    "/_next/image",
    "/favicon.ico",
    "/icon.svg",
    "/apple-icon.png",
  ])("leaves out %s, which is not an app page", (pathname) => {
    expect(matcher.test(pathname)).toBe(false);
  });
});

describe("the paths the proxy leaves out", () => {
  // #138
  it("are the ones next.config.ts leaves out of the rewrite on the portal's header", () => {
    // The matcher has to be a literal in proxy.ts, so the shared constant cannot be used there.
    expect(source).toBe(`/((?!${PROXY_SKIPPED_PATHS}).*)`);
  });
});
