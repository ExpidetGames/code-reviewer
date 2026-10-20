// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCanonicalCatalogAddress } from "./catalog-address.ts";

const VECTORS = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "contracts",
      "key-destination-vectors.json",
    ),
    "utf8",
  ),
) as { accepted: string[]; refused: string[] };

describe("the address of a catalog provider's key", () => {
  // #555-T13
  it.each(VECTORS.accepted)("accepts %s, as the runner does", (address) => {
    expect(isCanonicalCatalogAddress(address)).toBe(true);
  });

  // #555-T13
  it.each(VECTORS.refused)("refuses %j, as the runner does", (address) => {
    expect(isCanonicalCatalogAddress(address)).toBe(false);
  });

  // #555-T13
  it("is a set of vectors with both kinds in it", () => {
    expect(VECTORS.accepted.length).toBeGreaterThan(5);
    expect(VECTORS.refused.length).toBeGreaterThan(30);
  });
});
