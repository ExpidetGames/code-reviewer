// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DEBOUNCE_VARIABLE,
  debounceWarning,
  warnAboutDebounce,
} from "./debounce-config.ts";

// #395-T05
describe("the retired wait of a push before its review starts", () => {
  it("is silent when the variable is unset or empty", () => {
    for (const value of [undefined, "", "  "])
      expect(debounceWarning({ [DEBOUNCE_VARIABLE]: value })).toBeNull();
  });

  it.each(["0", "90", "600", "soon", "900"])(
    "says that the variable has no effect when it is set to %j, without repeating the value",
    (value) => {
      const line = debounceWarning({ REVIEW_DEBOUNCE_SECONDS: value });

      expect(line).toContain("REVIEW_DEBOUNCE_SECONDS");
      expect(line).toContain("no effect");
      expect(line).toContain("superseded");
      expect(line).not.toContain(`"${value}"`);
      expect(line).not.toContain(` ${value} `);
    },
  );

  it("is logged once through the given function, and not at all for an unset variable", () => {
    const lines: string[] = [];

    warnAboutDebounce({ REVIEW_DEBOUNCE_SECONDS: "60" }, (l) => lines.push(l));
    warnAboutDebounce({}, (l) => lines.push(l));

    expect(lines).toHaveLength(1);
  });
});
