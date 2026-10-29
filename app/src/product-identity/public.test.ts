// SPDX-License-Identifier: LicenseRef-Proprietary

// The identity of the build for the page that renders outside the root layout (#740).
//
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { identityFor } from "./identities.ts";
import { builtProductIdentity } from "./public.ts";

describe("the identity of the build", () => {
  // #740-T03
  it("is code-review.com when the build knows no product, and the product the build was made for otherwise", () => {
    expect(builtProductIdentity("")).toBe(identityFor("code-review-com"));
    expect(builtProductIdentity(undefined)).toBe(
      identityFor("code-review-com"),
    );
    expect(builtProductIdentity("factory")).toBe(identityFor("factory"));
    expect(builtProductIdentity(" factory ")).toBe(identityFor("factory"));
  });

  // #740-T03
  it("does not invent a brand for a value that is no product", () => {
    expect(builtProductIdentity("software-factory")).toBe(
      identityFor("code-review-com"),
    );
  });
});

describe("the build setting the identity of the build is made from", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // #740-T07
  it("derives NEXT_PUBLIC_PRODUCT_ID from PRODUCT_ID, so only PRODUCT_ID has to be set per project", async () => {
    vi.stubEnv("PRODUCT_ID", "factory");
    vi.resetModules();
    const factory = (await import("../../next.config.ts")).default;
    expect(factory.env).toEqual({ NEXT_PUBLIC_PRODUCT_ID: "factory" });

    vi.stubEnv("PRODUCT_ID", "");
    vi.resetModules();
    const unset = (await import("../../next.config.ts")).default;
    expect(unset.env).toEqual({ NEXT_PUBLIC_PRODUCT_ID: "" });
  });
});
