// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { formatUtc } from "./format-time.ts";

describe("a time in a list", () => {
  it("is written in UTC the same way on the server and in the browser", () => {
    expect(formatUtc("2026-10-10T12:34:56.789Z")).toBe("2026-10-10 12:34 UTC");
  });

  it("says it is unknown when the text is no time", () => {
    expect(formatUtc("yesterday")).toBe("unknown time");
  });
});
