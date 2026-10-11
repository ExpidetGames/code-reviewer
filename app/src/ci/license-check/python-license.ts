// SPDX-License-Identifier: Apache-2.0

// Turns what the metadata of an installed Python package says about its license into one SPDX
// expression. Modern packages carry a License-Expression. Older ones have a free-text License field
// (a name such as "Apache 2.0", sometimes a whole license text) and trove classifiers
// ("License :: OSI Approved :: MIT License"). The order of trust is: expression, a license field that
// names a license, the classifiers (joined with AND, so that every one has to be allowed), and NONE
// for a package that declares nothing. Whatever cannot be read becomes LicenseRef-Unrecognized,
// which no policy allows, so a new spelling shows up as a failure to look at, never as a pass.
import { parseExpression } from "./spdx.ts";

export type PythonMetadata = {
  name: string;
  version: string;
  /** The License-Expression field. */
  expression: string | null;
  /** The License field (the start of it, when it holds a license text). */
  license: string | null;
  /** The classifiers that start with "License ::". */
  classifiers: string[];
};

export const UNRECOGNIZED_LICENSE = "LicenseRef-Unrecognized" as const;
export const NO_LICENSE = "NONE" as const;

// Lower case spellings of the License field that SPDX does not know, and what they mean.
const NAMES: Record<string, string> = {
  "apache 2.0": "Apache-2.0",
  "apache 2": "Apache-2.0",
  "apache license 2.0": "Apache-2.0",
  "apache license, version 2.0": "Apache-2.0",
  "apache software license 2.0": "Apache-2.0",
  "apache software license": "Apache-2.0",
  "mit license": "MIT",
  "the mit license (mit)": "MIT",
  "mit license (mit)": "MIT",
  "mit/x11": "MIT",
  // "BSD" says nothing about the number of clauses; every BSD variant is permissive, and the
  // 3-clause one is the common case.
  bsd: "BSD-3-Clause",
  "bsd license": "BSD-3-Clause",
  "3-clause bsd license": "BSD-3-Clause",
  "new bsd license": "BSD-3-Clause",
  "gnu gpl 3": "GPL-3.0-only",
  "isc license (iscl)": "ISC",
  "mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
  "python software foundation license": "PSF-2.0",
};

// License fields that only say there is no usable answer.
const PLACEHOLDERS = new Set(["unknown", "other", "n/a", "see license file"]);

// The classifiers after "License :: ". Generic ones (any LGPL, any GPL) cannot name a version, so
// they become a LicenseRef that a policy has to allow by name.
const CLASSIFIERS: Record<string, string> = {
  "osi approved :: mit license": "MIT",
  "osi approved :: apache software license": "Apache-2.0",
  "osi approved :: bsd license": "BSD-3-Clause",
  "osi approved :: isc license (iscl)": "ISC",
  "osi approved :: python software foundation license": "PSF-2.0",
  "osi approved :: mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
  "osi approved :: gnu lesser general public license v3 (lgplv3)":
    "LGPL-3.0-only",
  "osi approved :: gnu lesser general public license v3 or later (lgplv3+)":
    "LGPL-3.0-or-later",
  "osi approved :: gnu library or lesser general public license (lgpl)":
    "LicenseRef-LGPL",
  "osi approved :: gnu general public license v3 (gplv3)": "GPL-3.0-only",
  "osi approved :: gnu general public license v3 or later (gplv3+)":
    "GPL-3.0-or-later",
  "osi approved :: gnu general public license (gpl)": "LicenseRef-GPL",
  "osi approved :: gnu affero general public license v3": "AGPL-3.0-only",
  "osi approved :: the unlicense (unlicense)": "Unlicense",
};

// Classifiers that carry no license.
const NOT_A_LICENSE = new Set(["dfsg approved", "osi approved"]);

function isExpression(text: string): boolean {
  try {
    parseExpression(text);
    return true;
  } catch {
    return false;
  }
}

function fromLicenseField(field: string): string | null {
  const firstLine = field.split("\n").find((line) => line.trim() !== "");
  if (firstLine === undefined) return null;
  const line = firstLine.trim();
  const named = NAMES[line.toLowerCase()];
  if (named) return named;
  // A placeholder says nothing; a valid classifier next to it should decide.
  if (PLACEHOLDERS.has(line.toLowerCase())) return null;
  // A whole field that is one short line and reads as an expression ("MPL-2.0 AND MIT") is taken
  // as it is. A sentence or a copyright line does not parse and falls through to the classifiers.
  if (line === field.trim() && line.length <= 100 && isExpression(line)) {
    return line;
  }
  return null;
}

function fromClassifiers(classifiers: string[]): string | null {
  const ids: string[] = [];
  for (const classifier of classifiers) {
    const name = classifier
      .replace(/^License ::\s*/, "")
      .trim()
      .toLowerCase();
    if (NOT_A_LICENSE.has(name)) continue;
    const id = CLASSIFIERS[name];
    ids.push(id ?? UNRECOGNIZED_LICENSE);
  }
  if (ids.length === 0) return null;
  return [...new Set(ids)].join(" AND ");
}

export function pythonLicenseExpression(metadata: PythonMetadata): string {
  if (metadata.expression && metadata.expression.trim() !== "") {
    return metadata.expression.trim();
  }
  const field = metadata.license?.trim() ?? "";
  if (field !== "") {
    const fromField = fromLicenseField(field);
    if (fromField) return fromField;
  }
  const fromTrove = fromClassifiers(metadata.classifiers);
  if (fromTrove) return fromTrove;
  return field === "" ? NO_LICENSE : UNRECOGNIZED_LICENSE;
}
