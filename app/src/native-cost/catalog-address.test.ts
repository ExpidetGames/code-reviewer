// SPDX-License-Identifier: LicenseRef-Proprietary

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

  // #555-T14
  it("accepts no IP literal in any spelling, and the vectors keep them all on the refused side", () => {
    const literal = /^https:\/\/(\[|[0-9.x]+(\/|$))/i;
    expect(VECTORS.accepted.filter((a) => literal.test(a))).toEqual([]);
    for (const address of [
      "https://93.184.216.34/v1",
      "https://1572395042/v1",
      "https://0x5db8d822/v1",
      "https://[2606:4700:4700:0:0:0:0:1111]/v1",
      "https://[2606:4700:4700::1111%25eth0]/v1",
      "https://[::ffff:93.184.216.34]/v1",
      "https://[2002:5db8:d822::1]/v1",
      "https://[64:ff9b::5db8:d822]/v1",
    ]) {
      expect(VECTORS.refused).toContain(address);
      expect(isCanonicalCatalogAddress(address)).toBe(false);
    }
  });
});
