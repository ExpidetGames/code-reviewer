// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  capabilityConfigProblems,
  PRODUCTS,
  resolveCapabilityConfig,
} from "./products.ts";

function resolved(env: Record<string, string | undefined>) {
  const config = resolveCapabilityConfig(env);
  if (!config.ok) throw new Error(config.problems.join("; "));
  return { product: config.product, list: config.capabilities.list() };
}

describe("the capability set of a deployment", () => {
  // #731-T01
  it("is the default of code-review.com when nothing is set, so today's deployment needs no setting", () => {
    expect(resolved({})).toEqual({
      product: "code-review-com",
      list: ["review", "dynamic-review", "billing"],
    });
    expect(resolved({ PRODUCT_CAPABILITIES: "  ", PRODUCT_ID: "" })).toEqual({
      product: "code-review-com",
      list: ["review", "dynamic-review", "billing"],
    });
  });

  it("is the default of the factory product when it is named and no list is given", () => {
    expect(resolved({ PRODUCT_ID: "factory" })).toEqual({
      product: "factory",
      list: ["review", "dynamic-review"],
    });
  });

  // #731-T02
  it("reads a list that narrows the product, in a stable order", () => {
    expect(
      resolved({ PRODUCT_CAPABILITIES: "dynamic-review, review" }).list,
    ).toEqual(["review", "dynamic-review"]);
    expect(resolved({ PRODUCT_CAPABILITIES: "review" }).list).toEqual([
      "review",
    ]);
    expect(resolved({ PRODUCT_CAPABILITIES: "review,review" }).list).toEqual([
      "review",
    ]);
    expect(
      resolved({
        PRODUCT_ID: "factory",
        PRODUCT_CAPABILITIES: "review,billing",
      }).list,
    ).toEqual(["review", "billing"]);
  });

  // #731-T02
  it("refuses an unknown name without repeating it", () => {
    const problems = capabilityConfigProblems({
      PRODUCT_CAPABILITIES: "review,hunter2-secret",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("PRODUCT_CAPABILITIES");
    expect(problems[0]).not.toContain("hunter2");
  });

  // #731-T02
  it("refuses dynamic-review without review, and an empty list of names", () => {
    expect(
      capabilityConfigProblems({ PRODUCT_CAPABILITIES: "dynamic-review" }),
    ).toEqual([expect.stringContaining('"dynamic-review" but not "review"')]);
    expect(capabilityConfigProblems({ PRODUCT_CAPABILITIES: "," })).not.toEqual(
      [],
    );
  });

  // #731-T02
  it("refuses an unknown product", () => {
    expect(capabilityConfigProblems({ PRODUCT_ID: "other" })).toEqual([
      expect.stringContaining("PRODUCT_ID"),
    ]);
  });

  // #731-T08
  it("refuses implementer on code-review.com by name, and no product allows it yet", () => {
    expect(
      capabilityConfigProblems({ PRODUCT_CAPABILITIES: "review,implementer" }),
    ).toEqual([
      expect.stringMatching(/"implementer".*code-review-com does not allow/),
    ]);
    for (const [id, product] of Object.entries(PRODUCTS))
      expect(product.allowed, id).not.toContain("implementer");
    expect(
      capabilityConfigProblems({
        PRODUCT_ID: "factory",
        PRODUCT_CAPABILITIES: "implementer",
      }),
    ).not.toEqual([]);
  });

  it("keeps every default inside the allowed list and closed under the requirements", () => {
    for (const [id, product] of Object.entries(PRODUCTS)) {
      for (const capability of product.default)
        expect(product.allowed, id).toContain(capability);
      if (product.default.includes("dynamic-review"))
        expect(product.default, id).toContain("review");
    }
  });
});
