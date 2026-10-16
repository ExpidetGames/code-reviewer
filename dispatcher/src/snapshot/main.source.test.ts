// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Two properties of the entry file that a run against the real platform would show too late.
const source = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

describe("the snapshot:build entry file", () => {
  // #330-extra-main
  it("checks the platform SDK against the adapter's interface instead of casting it", () => {
    expect(source).toContain("satisfies SandboxSdk");
    expect(source).not.toContain("as unknown as");
  });

  // #330-extra-main
  it("lets pending output drain: it sets the exit code and does not exit at once", () => {
    expect(source).toContain("process.exitCode = code");
    expect(source).not.toMatch(/^process\.exit\(code\)/m);
  });
});
