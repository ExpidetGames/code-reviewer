// SPDX-License-Identifier: Apache-2.0

// #491: the subscription design with plans is gone (ADR 0006 replaces it with prepaid billing). This scan keeps the repository
// free of it, and keeps the billing switch to one reader. The name is built from parts, so that this file does not carry it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listTrackedFiles } from "./tracked-files.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const REMOVED_VENDOR = ["pad", "dle"].join("");
const REMOVED_TABLE_PREFIX = ["billing", "_plan"].join("");
const REMOVED_FILE_PREFIX = ["billing", "-plan"].join("");

/** Decision records keep the history, so they may name what was removed. */
function isDecisionRecord(path: string): boolean {
  return path.startsWith("docs/decisions/");
}

describe("the billing cleanup", () => {
  // #491-T01
  it("leaves no tracked file outside docs/decisions that names the removed vendor", () => {
    const found: string[] = [];
    for (const path of listTrackedFiles(repoRoot)) {
      if (isDecisionRecord(path)) continue;
      if (path.toLowerCase().includes(REMOVED_VENDOR))
        found.push(`${path} is named after it`);
      const content = readFileSync(`${repoRoot}${path}`, "utf8");
      if (content.toLowerCase().includes(REMOVED_VENDOR))
        found.push(`${path} mentions it`);
    }
    expect(found).toEqual([]);
  });

  // #491-T01
  it("leaves no file named after a billing plan", () => {
    const found = listTrackedFiles(repoRoot).filter(
      (path) =>
        !isDecisionRecord(path) &&
        (path.includes(REMOVED_TABLE_PREFIX) ||
          path.includes(REMOVED_FILE_PREFIX)),
    );
    expect(found).toEqual([]);
  });

  // #491-T10
  it("reads the billing switch in exactly one place", () => {
    const readers = listTrackedFiles(repoRoot).filter((path) => {
      if (!path.startsWith("app/src/") || !path.endsWith(".ts")) return false;
      if (/\.(test|integration\.test)\.tsx?$/.test(path)) return false;
      if (path.startsWith("app/src/test-support/")) return false;
      return /\.get\(\s*"billing_settings"\s*\)/.test(
        readFileSync(`${repoRoot}${path}`, "utf8"),
      );
    });
    expect(readers).toEqual(["app/src/billing/enabled.ts"]);
  });
});
