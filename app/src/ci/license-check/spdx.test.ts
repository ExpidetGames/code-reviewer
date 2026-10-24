// SPDX-License-Identifier: LicenseRef-Proprietary

// #118: the evaluation of SPDX license expressions, the form in which package metadata names
// licenses ("MIT", "(MIT OR Apache-2.0)", "Apache-2.0 AND LGPL-3.0-or-later").
import { describe, expect, it } from "vitest";
import { parseExpression, satisfies, licenseIds } from "./spdx.ts";

const permissive = (id: string) =>
  ["mit", "apache-2.0", "bsd-3-clause"].includes(id.toLowerCase());

describe("parseExpression", () => {
  it("reads a single license id", () => {
    expect(licenseIds(parseExpression("MIT"))).toEqual(["MIT"]);
  });

  it("keeps the plus of an or-later id as part of the id", () => {
    expect(licenseIds(parseExpression("GPL-2.0+"))).toEqual(["GPL-2.0+"]);
  });

  it("reads OR and AND with parentheses", () => {
    const expression = parseExpression("(MIT OR Apache-2.0) AND BSD-3-Clause");

    expect(licenseIds(expression)).toEqual([
      "MIT",
      "Apache-2.0",
      "BSD-3-Clause",
    ]);
  });

  it("treats a WITH exception as part of one license", () => {
    expect(
      licenseIds(parseExpression("Apache-2.0 WITH LLVM-exception")),
    ).toEqual(["Apache-2.0 WITH LLVM-exception"]);
  });

  it("accepts operators in lower case, as older package metadata writes them", () => {
    expect(licenseIds(parseExpression("MIT or Apache-2.0"))).toEqual([
      "MIT",
      "Apache-2.0",
    ]);
  });

  it.each(["", "MIT OR", "(MIT", "MIT)", "MIT AND AND ISC", "OR MIT", "()"])(
    "rejects the malformed expression %j",
    (text) => {
      expect(() => parseExpression(text)).toThrow("INVALID_SPDX_EXPRESSION");
    },
  );
});

describe("satisfies", () => {
  it("is true for an allowed id", () => {
    expect(satisfies(parseExpression("MIT"), permissive)).toBe(true);
  });

  it("is false for an id that is not allowed", () => {
    expect(satisfies(parseExpression("GPL-3.0-only"), permissive)).toBe(false);
  });

  it("is true for OR when one choice is allowed", () => {
    expect(satisfies(parseExpression("GPL-3.0-only OR MIT"), permissive)).toBe(
      true,
    );
  });

  it("is false for AND when one part is not allowed", () => {
    expect(satisfies(parseExpression("MIT AND GPL-3.0-only"), permissive)).toBe(
      false,
    );
  });

  it("gives AND a higher precedence than OR", () => {
    // MIT OR (GPL AND GPL) is allowed; (MIT OR GPL) AND GPL is not.
    expect(
      satisfies(
        parseExpression("MIT OR GPL-3.0-only AND GPL-2.0-only"),
        permissive,
      ),
    ).toBe(true);
    expect(
      satisfies(
        parseExpression("(MIT OR GPL-3.0-only) AND GPL-2.0-only"),
        permissive,
      ),
    ).toBe(false);
  });

  it("compares ids without regard to case", () => {
    expect(satisfies(parseExpression("apache-2.0"), permissive)).toBe(true);
  });
});
