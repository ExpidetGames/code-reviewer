// SPDX-License-Identifier: LicenseRef-Proprietary

// The identity of the build for the page that renders outside the root layout (#740).
//
// @vitest-environment node
import { describe, expect, it } from "vitest";
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
