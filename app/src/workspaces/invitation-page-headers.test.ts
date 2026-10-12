// SPDX-License-Identifier: Apache-2.0

// Pins down that the pages whose address can carry an invitation link send `Referrer-Policy: no-referrer`
// (a header, so it holds before the page has loaded anything), and that the page of the invitation also asks
// in its metadata. The real response is checked in the browser journey (e2e/workspaces/).
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.ts";
import { metadata } from "../app/invitation/page.tsx";

describe("the pages that can carry an invitation link in their address", () => {
  // #101-WM-24
  it("send Referrer-Policy: no-referrer for the invitation, the login and the sign-up", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];

    const matching = rules.filter((rule) =>
      rule.headers.some(
        (header) =>
          header.key === "Referrer-Policy" && header.value === "no-referrer",
      ),
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.source).toBe("/:path(invitation|login|sign-up)");
  });

  // #101-WM-24
  it("ask for the same in the metadata of the page of the invitation, which no search engine indexes", () => {
    expect(metadata.referrer).toBe("no-referrer");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
