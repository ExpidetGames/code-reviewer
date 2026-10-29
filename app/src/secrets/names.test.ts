// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { composeSecretNames, SecretNamesError } from "./names.ts";

describe("composing the names of the secrets", () => {
  // #715-T06
  it("joins the lists of the application in alphabetical order", () => {
    expect(composeSecretNames(["b", "d"], ["c"], ["a"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  // #423-T04
  it("refuses a name that two lists share and a name that is listed twice", () => {
    expect(() => composeSecretNames(["a", "b"], ["b"])).toThrow(
      SecretNamesError,
    );
    expect(() => composeSecretNames(["a", "a"])).toThrow(/secret_name_taken/);
  });
});
