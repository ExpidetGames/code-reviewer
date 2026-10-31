// SPDX-License-Identifier: LicenseRef-Proprietary

// The rules of a new branch name (#755): `git check-ref-format --branch`, plus the ones of this product (not the base branch,
// at most 200 characters). Pure.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  BRANCH_NAME_MAX_LENGTH,
  checkBranchName,
  type BranchNameIssue,
} from "./branch-name.ts";

const VALID: string[] = [
  "implementer/abc123",
  "feature/x",
  "fix-1",
  "a",
  "release/2026.10",
  "user@example",
  "a/b/c/d",
  "ünïcode/ß",
  "with+plus",
  "with%percent",
  "with#hash",
  "dot.in.middle",
  "x".repeat(BRANCH_NAME_MAX_LENGTH),
  "{braces}",
  "tilde-at-end-ok-1",
];

const INVALID: [string, BranchNameIssue][] = [
  ["", "empty"],
  ["   ", "empty"],
  ["has space", "forbidden_character"],
  ["tab\there", "forbidden_character"],
  ["new\nline", "forbidden_character"],
  ["nul\u0000byte", "forbidden_character"],
  ["del\u007fchar", "forbidden_character"],
  ["tilde~1", "forbidden_character"],
  ["caret^", "forbidden_character"],
  ["colon:x", "forbidden_character"],
  ["quest?", "forbidden_character"],
  ["star*", "forbidden_character"],
  ["open[bracket", "forbidden_character"],
  ["back\\slash", "forbidden_character"],
  ["a..b", "double_dot"],
  ["..", "double_dot"],
  ["a@{b", "reflog_syntax"],
  ["@{", "reflog_syntax"],
  ["-leading", "leading_dash"],
  ["--force", "leading_dash"],
  ["branch.lock", "lock_suffix"],
  ["dir.lock/branch", "component_lock_suffix"],
  ["/leading-slash", "slash_placement"],
  ["trailing-slash/", "slash_placement"],
  ["double//slash", "slash_placement"],
  [".hidden", "component_leading_dot"],
  ["dir/.hidden", "component_leading_dot"],
  ["ends.", "trailing_dot"],
  ["@", "reserved_name"],
  ["HEAD", "reserved_name"],
  ["x".repeat(BRANCH_NAME_MAX_LENGTH + 1), "too_long"],
];

describe("the rules of a new branch name", () => {
  // #755-T05
  it.each(VALID)("accepts %j", (name) => {
    expect(checkBranchName(name, "main")).toEqual({ ok: true, value: name });
  });

  // #755-T05
  it.each(INVALID)("refuses %j with %s", (name, issue) => {
    expect(checkBranchName(name, "main")).toEqual({ ok: false, issue });
  });

  // #755-T04
  it("refuses the base branch, also with another spelling of case that git treats as another branch it accepts", () => {
    expect(checkBranchName("main", "main")).toEqual({
      ok: false,
      issue: "same_as_base",
    });
    expect(checkBranchName("Main", "main")).toEqual({
      ok: true,
      value: "Main",
    });
  });

  // #755-T05
  it("does not change the name it is given: no trimming that would make another branch of it", () => {
    expect(checkBranchName(" padded ", "main")).toEqual({
      ok: false,
      issue: "forbidden_character",
    });
  });

  // #755-T05
  it("has at least 30 cases", () => {
    expect(VALID.length + INVALID.length).toBeGreaterThanOrEqual(30);
  });

  // #755-T05
  it("agrees with the real `git check-ref-format --branch` for every name above that git can be asked about", () => {
    const gitAccepts = (name: string): boolean => {
      // A name with a NUL cannot be passed as an argument at all.
      if (name.includes("\u0000")) return false;
      try {
        execFileSync("git", ["check-ref-format", "--branch", name], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    };
    const disagreements = [
      ...VALID.map((name) => ({ name, expected: true })),
      ...INVALID.filter(([name]) => name.length <= 255).map(([name]) => ({
        name,
        expected: false,
      })),
    ]
      // `HEAD` and `@` (git's `--branch` reads `@` as HEAD and accepts it), a leading dash (an option) and a 201-character name
      // are rules of this product that `git check-ref-format` does not have; the others must agree.
      .filter(
        ({ name }) =>
          name !== "HEAD" &&
          name !== "@" &&
          !name.startsWith("-") &&
          name.length <= BRANCH_NAME_MAX_LENGTH,
      )
      .filter(({ name, expected }) => gitAccepts(name) !== expected);
    expect(disagreements).toEqual([]);
  });
});
