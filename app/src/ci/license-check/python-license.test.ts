// SPDX-License-Identifier: Apache-2.0

// #118: Python package metadata names a license in up to three ways (License-Expression, the
// free-text License field, trove classifiers). The lookup turns them into one SPDX expression.
import { describe, expect, it } from "vitest";
import { pythonLicenseExpression } from "./python-license.ts";

function record(over: {
  expression?: string | null;
  license?: string | null;
  classifiers?: string[];
}) {
  return {
    name: "example",
    version: "1.0.0",
    expression: null,
    license: null,
    classifiers: [],
    ...over,
  };
}

describe("pythonLicenseExpression", () => {
  it("prefers the license expression of the metadata", () => {
    expect(
      pythonLicenseExpression(
        record({
          expression: "Apache-2.0 OR BSD-3-Clause",
          license: "something else",
          classifiers: ["License :: OSI Approved :: MIT License"],
        }),
      ),
    ).toBe("Apache-2.0 OR BSD-3-Clause");
  });

  it("uses a short license field that already is an SPDX expression", () => {
    expect(
      pythonLicenseExpression(record({ license: "MPL-2.0 AND MIT" })),
    ).toBe("MPL-2.0 AND MIT");
  });

  it.each([
    ["Apache 2.0", "Apache-2.0"],
    ["Apache License, Version 2.0", "Apache-2.0"],
    ["Apache Software License 2.0", "Apache-2.0"],
    ["MIT License", "MIT"],
    ["3-Clause BSD License", "BSD-3-Clause"],
    ["GNU GPL 3", "GPL-3.0-only"],
  ])("maps the common spelling %j to %s", (text, expected) => {
    expect(pythonLicenseExpression(record({ license: text }))).toBe(expected);
  });

  it("reads the first line of a license field that holds a whole license text", () => {
    expect(
      pythonLicenseExpression(
        record({
          license:
            "MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted",
        }),
      ),
    ).toBe("MIT");
  });

  it("falls back to the classifiers when the license field is not a license name", () => {
    expect(
      pythonLicenseExpression(
        record({
          license: "Copyright (c) 2021, Someone\nAll rights reserved.",
          classifiers: ["License :: OSI Approved :: BSD License"],
        }),
      ),
    ).toBe("BSD-3-Clause");
  });

  it("joins several classifiers with AND, so every one of them has to be allowed", () => {
    expect(
      pythonLicenseExpression(
        record({
          classifiers: [
            "License :: OSI Approved :: Apache Software License",
            "License :: OSI Approved :: GNU General Public License v3 (GPLv3)",
          ],
        }),
      ),
    ).toBe("Apache-2.0 AND GPL-3.0-only");
  });

  it("ignores classifiers that do not name a license", () => {
    expect(
      pythonLicenseExpression(
        record({
          classifiers: [
            "License :: DFSG approved",
            "License :: OSI Approved :: MIT License",
          ],
        }),
      ),
    ).toBe("MIT");
  });

  it("ignores a placeholder license field such as UNKNOWN when a classifier names the license", () => {
    expect(
      pythonLicenseExpression(
        record({
          license: "UNKNOWN",
          classifiers: ["License :: OSI Approved :: MIT License"],
        }),
      ),
    ).toBe("MIT");
  });

  it("marks an unknown classifier so the check reports it", () => {
    expect(
      pythonLicenseExpression(
        record({ classifiers: ["License :: Totally New :: Thing"] }),
      ),
    ).toBe("LicenseRef-Unrecognized");
  });

  it("reports NONE for a package that declares no license at all", () => {
    expect(pythonLicenseExpression(record({}))).toBe("NONE");
  });

  it("marks a license text it cannot read as unrecognized", () => {
    expect(
      pythonLicenseExpression(record({ license: "See the file somewhere" })),
    ).toBe("LicenseRef-Unrecognized");
  });
});
