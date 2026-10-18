// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { STDERR_TAIL_MAX_CHARS, stderrTail } from "./vm-prepare-log.ts";

describe("stderrTail", () => {
  // #473-T03
  it("keeps the text of a short stderr on one line", () => {
    expect(
      stderrTail(
        "vm-prepare: cgroup_root_busy tries=100 last_error=Device or resource busy\n" +
          "vm-prepare: left_in_root 1:sandbox-init\n",
      ),
    ).toBe(
      "vm-prepare: cgroup_root_busy tries=100 last_error=Device or resource busy | vm-prepare: left_in_root 1:sandbox-init",
    );
  });

  // #473-T03
  it("is empty for an empty stderr", () => {
    expect(stderrTail("")).toBe("");
    expect(stderrTail("\n \n")).toBe("");
  });

  // #473-T04
  it("keeps only the last lines and at most the capped length, the end of the text", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);

    const tail = stderrTail(lines.join("\n"));

    expect(tail).toContain("line 49");
    expect(tail).not.toContain("line 0 ");
    expect(tail.split(" | ").length).toBeLessThanOrEqual(8);

    const long = stderrTail("x ".repeat(5_000) + "THE-END");
    expect(long.length).toBeLessThanOrEqual(STDERR_TAIL_MAX_CHARS + 1);
    expect(long.endsWith("THE-END")).toBe(true);
  });

  // #473-T04
  it("masks a credential, an Authorization value and any long token-shaped value", () => {
    const credential = `crj_${"A".repeat(43)}`;
    const long = "Zm9v".repeat(12);

    const tail = stderrTail(
      [
        `job credential ${credential}`,
        "Authorization: Bearer abc.def-ghi",
        `value ${long}`,
        "ghp_" + "b".repeat(36),
      ].join("\n"),
    );

    expect(tail).not.toContain(credential);
    expect(tail).not.toContain("abc.def-ghi");
    expect(tail).not.toContain(long);
    expect(tail).not.toContain("ghp_b");
    expect(tail).toContain("[redacted]");
  });

  // #473-T04
  it("drops control characters and escape sequences", () => {
    const tail = stderrTail("\u001b[31mred\u001b[0m\u0000 text\r\nnext\u0007");

    expect(tail).toBe("red text | next");
  });
});
