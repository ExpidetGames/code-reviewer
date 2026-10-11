// SPDX-License-Identifier: Apache-2.0

// The two rewrites in next.config.ts that make a request for the files of the portal by their own address
// answer as a path that does not exist (src/admin/paths.ts). Whether the answers really are the same is
// proven against a production build in e2e/admin/admin-portal.e2e.ts; this keeps the configuration from
// being changed without anyone noticing.
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.ts";
import { MISSING_PATH, PORTAL_DENIED_HEADER } from "./paths.ts";

async function rewrites() {
  const result = await nextConfig.rewrites?.();
  if (result === undefined || Array.isArray(result))
    throw new Error("next.config.ts has no rewrites in the three-part form");
  return result;
}

describe("the rewrites of next.config.ts", () => {
  // #138
  it("send a request the proxy marked to the missing path before any file is looked at", async () => {
    const { beforeFiles } = await rewrites();

    expect(beforeFiles).toHaveLength(1);
    const [rule] = beforeFiles ?? [];
    expect(rule?.has).toEqual([{ type: "header", key: PORTAL_DENIED_HEADER }]);
    expect(rule?.destination).toBe(MISSING_PATH);
    // Only what the proxy sees: the proxy takes the header off a request from outside, and does not see
    // Next.js's static files, the image route and the favicon.
    const matches = new RegExp(
      `^${(rule?.source ?? "").replace("/:path", "")}$`,
    );
    for (const seen of ["/", "/login", "/admin/setup", "/instance-portal/x"])
      expect(matches.test(seen.slice(1)), seen).toBe(true);
    for (const skipped of [
      "_next/static/chunks/a.js",
      "_next/image",
      "favicon.ico",
    ])
      expect(matches.test(skipped), skipped).toBe(false);
  });

  // #138
  it("send every other path that is no route to the same missing path, except Next.js's own files", async () => {
    const { fallback, afterFiles } = await rewrites();

    expect(afterFiles).toEqual([]);
    expect(fallback).toHaveLength(1);
    const [rule] = fallback ?? [];
    expect(rule?.destination).toBe(MISSING_PATH);
    // A regular expression in a Next.js source is anchored like a path-to-regexp group.
    const source = (rule?.source ?? "").replace("/:path", "");
    const matches = new RegExp(`^${source}$`);
    expect(matches.test("there-is-no-such-page")).toBe(true);
    expect(matches.test("a/b/c")).toBe(true);
    expect(matches.test("_next/static/chunks/a.js")).toBe(false);
  });
});
