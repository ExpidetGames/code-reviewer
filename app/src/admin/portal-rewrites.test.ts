// SPDX-License-Identifier: Apache-2.0

// The two rewrites in next.config.ts that make a request for the files of the portal by their own address
// answer as a path that does not exist (src/admin/paths.ts). Whether the answers really are the same is
// proven against a production build in e2e/admin/admin-portal.e2e.ts; this keeps the configuration from
// being changed without anyone noticing.
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.ts";
import {
  MISSING_PATH,
  PORTAL_API_ROOT,
  PORTAL_DENIED_HEADER,
  PORTAL_PAGE_ROOT,
  PORTAL_REWRITE_HEADER,
  PROXY_SKIPPED_PATHS,
  portalRewriteTarget,
} from "./paths.ts";

async function rewrites() {
  const result = await nextConfig.rewrites?.();
  if (result === undefined || Array.isArray(result))
    throw new Error("next.config.ts has no rewrites in the three-part form");
  return result;
}

// Turns a source of the form `/prefix/:path*` into a test on a path and, for a match, the destination with the
// rest of the path filled in (a Next.js source of this form matches the prefix alone as well).
function applied(
  rule: { source: string; destination: string },
  path: string,
): string | null {
  const prefix = rule.source.replace("/:path*", "");
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  return `${rule.destination.replace("/:path*", "")}${path.slice(prefix.length)}`;
}

describe("the rewrites of next.config.ts", () => {
  // #146
  it("serve the portal's addresses from its files when the proxy marked the request, and do nothing else", async () => {
    const { beforeFiles } = await rewrites();
    const rules = (beforeFiles ?? []).filter((candidate) =>
      candidate.destination.includes(":path*"),
    );

    expect(rules.map((rule) => rule.destination)).toEqual([
      `${PORTAL_PAGE_ROOT}/:path*`,
      `${PORTAL_API_ROOT}/:path*`,
    ]);
    // Only a request that carries the header the proxy sets for the instance admin, nothing else.
    for (const rule of rules)
      expect(rule.has).toEqual([
        { type: "header", key: PORTAL_REWRITE_HEADER },
      ]);
    // The same places as the proxy decides on (portalRewriteTarget), for the spellings Next.js hands on.
    for (const path of [
      "/admin",
      "/admin/setup",
      "/admin/github/check",
      "/api/admin/settings",
      "/api/admin/github/manifest/callback",
    ])
      expect(
        rules.map((rule) => applied(rule, path)).find((hit) => hit !== null),
        path,
      ).toBe(portalRewriteTarget(path));
    for (const path of ["/", "/administrator", "/api/administrator", "/w/a"])
      expect(
        rules.map((rule) => applied(rule, path)).find((hit) => hit !== null),
        path,
      ).toBeUndefined();
  });

  // #146
  it("have sources that no path the proxy leaves out can match, so a header sent from outside never reaches them", async () => {
    const { beforeFiles } = await rewrites();
    const portal = (beforeFiles ?? []).filter((rule) =>
      rule.has?.some((item) => item.key === PORTAL_REWRITE_HEADER),
    );

    expect(portal).toHaveLength(2);
    // The paths of PROXY_SKIPPED_PATHS (the alternatives of the matcher), made concrete.
    const skipped = [
      "/_next/static/chunks/a.js",
      "/_next/image",
      "/favicon.ico",
    ];
    for (const rule of portal)
      for (const path of skipped)
        expect(applied(rule, path), `${rule.source} ${path}`).toBeNull();
    // And the sources stay below the portal's two roots, which are not among the skipped paths.
    for (const rule of portal)
      expect(
        rule.source.startsWith("/admin/") ||
          rule.source.startsWith("/api/admin/"),
      ).toBe(true);
    for (const path of skipped)
      expect(new RegExp(`^/(${PROXY_SKIPPED_PATHS})`).test(path)).toBe(true);
  });

  // #146
  it("put the portal's rewrites in front of the one for a marked request for a missing path", async () => {
    const { beforeFiles } = await rewrites();

    expect(beforeFiles?.at(-1)?.destination).toBe(MISSING_PATH);
  });

  // #138
  it("send a request the proxy marked to the missing path before any file is looked at", async () => {
    const { beforeFiles } = await rewrites();

    const rules = (beforeFiles ?? []).filter(
      (candidate) => candidate.destination === MISSING_PATH,
    );
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule?.has).toEqual([{ type: "header", key: PORTAL_DENIED_HEADER }]);
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
