// SPDX-License-Identifier: LicenseRef-Proprietary

// The rules of the name of a new branch (#755): those of `git check-ref-format --branch`, because the Worker creates the branch
// with git and GitHub holds it as a ref, plus two of this product (at most 200 characters, not the base branch). The name is
// checked as it is written, nothing is trimmed or replaced: a changed name would be another branch than the person typed. Each
// rule has a stable code, so the form can say which one a name breaks. Pure; imports nothing.

export const BRANCH_NAME_MAX_LENGTH = 200;

export const BRANCH_NAME_ISSUES = [
  /** Nothing, or only white space. */
  "empty",
  /** More than `BRANCH_NAME_MAX_LENGTH` characters. */
  "too_long",
  /** A space, control character, `~ ^ : ? * [` or a backslash. */
  "forbidden_character",
  /** `..` anywhere. */
  "double_dot",
  /** `@{` anywhere (git's reflog syntax). */
  "reflog_syntax",
  /** Starts with `-`: git would read it as an option. */
  "leading_dash",
  /** Starts or ends with `/`, or has `//`. */
  "slash_placement",
  /** A part between slashes starts with `.`. */
  "component_leading_dot",
  /** The whole name ends with `.lock`. */
  "lock_suffix",
  /** A part between slashes ends with `.lock`. */
  "component_lock_suffix",
  /** Ends with `.`. */
  "trailing_dot",
  /** `@` alone, or `HEAD`. */
  "reserved_name",
  /** The new branch is the branch the work starts from. */
  "same_as_base",
] as const;
export type BranchNameIssue = (typeof BRANCH_NAME_ISSUES)[number];

export type BranchNameCheck =
  { ok: true; value: string } | { ok: false; issue: BranchNameIssue };

// Space, ASCII control characters (git: below 0x20, and DEL), and the characters git refuses in a ref name.
// eslint-disable-next-line no-control-regex -- the control characters are exactly what is looked for
const FORBIDDEN = /[\u0000- \u007f~^:?*[\\]/;

/** The first rule `name` breaks, or the name itself. `base` is the branch the task starts from. */
export function checkBranchName(name: string, base: string): BranchNameCheck {
  const refuse = (issue: BranchNameIssue): BranchNameCheck => ({
    ok: false,
    issue,
  });
  if (name.trim() === "") return refuse("empty");
  if (name.length > BRANCH_NAME_MAX_LENGTH) return refuse("too_long");
  if (FORBIDDEN.test(name)) return refuse("forbidden_character");
  if (name.includes("..")) return refuse("double_dot");
  if (name.includes("@{")) return refuse("reflog_syntax");
  if (name.startsWith("-")) return refuse("leading_dash");
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//"))
    return refuse("slash_placement");
  const parts = name.split("/");
  if (parts.some((part) => part.startsWith(".")))
    return refuse("component_leading_dot");
  if (name.endsWith(".lock")) return refuse("lock_suffix");
  if (parts.some((part) => part.endsWith(".lock")))
    return refuse("component_lock_suffix");
  if (name.endsWith(".")) return refuse("trailing_dot");
  if (name === "@" || name === "HEAD") return refuse("reserved_name");
  if (name === base) return refuse("same_as_base");
  return { ok: true, value: name };
}
