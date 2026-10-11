// SPDX-License-Identifier: Apache-2.0

// Pins down the proxy matcher: it must match every path except Next.js's own static files, because
// "default deny" only holds for paths the proxy sees. A path missing from the match is open.
import { describe, expect, it } from "vitest";
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
    "/_next/data/build/x.json",
  ])("sees %s", (pathname) => {
    expect(matcher.test(pathname)).toBe(true);
  });

  it.each(["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico"])(
    "leaves out %s, which is not an app page",
    (pathname) => {
      expect(matcher.test(pathname)).toBe(false);
    },
  );
});
