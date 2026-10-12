// SPDX-License-Identifier: Apache-2.0

// The rewrite in next.config.ts that serves the setup page in place of the page the setup gate
// marked (src/setup/paths.ts). The proxy builds no address, so a client's `X-Forwarded-Proto` cannot
// end up in a rewrite that Next.js takes for a request to another server (bug #155, the same fix as
// #146 for the admin portal). Whether the answer really is the setup page is proven against a
// production build in e2e/setup/first-run.e2e.ts; this keeps the configuration from being changed
// without anyone noticing.
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.ts";
import { MISSING_PATH, PROXY_SKIPPED_PATHS } from "../admin/paths.ts";
import { SETUP_PAGE, SETUP_REWRITE_HEADER } from "./paths.ts";

async function rewrites() {
  const result = await nextConfig.rewrites?.();
  if (result === undefined || Array.isArray(result))
    throw new Error("next.config.ts has no rewrites in the three-part form");
  return result;
}

function setupRules(
  beforeFiles: NonNullable<Awaited<ReturnType<typeof rewrites>>["beforeFiles"]>,
) {
  return beforeFiles.filter((rule) =>
    rule.has?.some((item) => item.key === SETUP_REWRITE_HEADER),
  );
}

describe("the setup rewrite of next.config.ts", () => {
  // #155
  it("serves the setup page when the setup gate marked the request, and nothing else", async () => {
    const { beforeFiles } = await rewrites();
    const rules = setupRules(beforeFiles ?? []);

    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule?.destination).toBe(SETUP_PAGE);
    // Only a request that carries the header the setup gate sets, nothing else.
    expect(rule?.has).toEqual([{ type: "header", key: SETUP_REWRITE_HEADER }]);
  });

  // #155
  it("matches every path the proxy sees, so any page the gate marked is served from the setup page", async () => {
    const { beforeFiles } = await rewrites();
    const [rule] = setupRules(beforeFiles ?? []);
    const source = (rule?.source ?? "").replace("/:path", "");
    const matches = new RegExp(`^${source}$`);

    for (const seen of [
      "/",
      "/projects",
      "/login",
      "/admin/setup",
      "/w/acme/projects",
      "/api/projects",
    ])
      expect(matches.test(seen.slice(1)), seen).toBe(true);
    // Next.js's own files: the proxy does not see them, so a header sent from outside never reaches
    // this rewrite for them.
    expect(rule?.source).toContain(PROXY_SKIPPED_PATHS);
    for (const skipped of [
      "_next/static/chunks/a.js",
      "_next/image",
      "favicon.ico",
    ])
      expect(matches.test(skipped), skipped).toBe(false);
  });

  // #155
  it("is applied before a path that is no route gets the missing path", async () => {
    const { beforeFiles, afterFiles, fallback } = await rewrites();

    expect(setupRules(beforeFiles ?? [])).toHaveLength(1);
    expect(afterFiles).toEqual([]);
    expect(fallback?.at(-1)?.destination).toBe(MISSING_PATH);
  });
});
