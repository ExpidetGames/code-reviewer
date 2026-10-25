// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// #169: the copy pass. Every consolidated sentence has exactly one owner module, and no two message
// modules write the same paragraph. These are grep-style checks: the test reads the sources instead of
// importing them, so it sees a sentence wherever it is written, in a component or in a message module.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_HINT,
  PASSWORDS_DO_NOT_MATCH,
} from "../auth/password-policy.ts";
import {
  GITHUB_NOT_CONFIGURED_COPY,
  GITHUB_NOT_CONFIGURED_TITLE,
} from "../config-status/notices.ts";
import {
  STORED_ENCRYPTED_HINT,
  UNREADABLE_SECRET_CAUSE,
} from "../secrets/messages.ts";
import { INVITATION_LINK_LIFETIME } from "../workspaces/ui/messages.ts";
import {
  GITHUB_SIGN_IN_NOT_CONFIGURED,
  GITHUB_SIGN_IN_NOT_ENABLED,
  PRIVATE_APP_WHERE_HINT,
} from "../github-config/ui/messages.ts";
import {
  FAIL_CLOSED_WARNING,
  SIGN_UP_RULE_OPTIONS,
} from "../signup/ui/rule-copy.ts";
import { TENANCY_OPTIONS } from "../signup/ui/tenancy-copy.ts";
import { PROJECT_STATE_NOTICE } from "../projects/ui/messages.ts";
import {
  CROSS_SITE_REQUEST,
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  ENTRIES_REQUIRED,
  ENTRY_INVALID,
  INVALID_EMAIL,
  INVALID_VALUES,
  NOT_AVAILABLE_TO_YOU,
  REQUEST_NOT_UNDERSTOOD,
  ROLE_NOT_ALLOWED,
  SESSION_ENDED,
  TOO_MANY_ATTEMPTS,
  TOO_MANY_ENTRIES,
  UNAVAILABLE,
} from "./messages.ts";

const APP_SRC = fileURLToPath(new URL("..", import.meta.url)); // app/src/

/** Every source file below `app/src/`, without the test files. */
function sourceFiles(): string[] {
  return readdirSync(APP_SRC, { recursive: true })
    .map(String)
    .filter((path) => /\.tsx?$/.test(path))
    .filter((path) => !/\.(test|spec)\.tsx?$/.test(path));
}

/** The source files that contain `fragment` verbatim, sorted. */
function filesContaining(fragment: string): string[] {
  return sourceFiles()
    .filter((path) =>
      readFileSync(`${APP_SRC}${path}`, "utf8").includes(fragment),
    )
    .sort();
}

/**
 * Every consolidated sentence of #169, with its one owner module. `sourceFiles()` scans the whole of
 * `app/src/`, so a sentence pasted into a screen fails here just as a second message module does.
 */
const CONSOLIDATED: ReadonlyArray<readonly [string, string]> = [
  [PASSWORD_RULE_HINT, "auth/password-policy.ts"],
  [PASSWORDS_DO_NOT_MATCH, "auth/password-policy.ts"],
  [UNREADABLE_SECRET_CAUSE, "secrets/messages.ts"],
  [STORED_ENCRYPTED_HINT, "secrets/messages.ts"],
  [GITHUB_NOT_CONFIGURED_TITLE, "config-status/notices.ts"],
  [GITHUB_NOT_CONFIGURED_COPY, "config-status/notices.ts"],
  [GITHUB_SIGN_IN_NOT_ENABLED, "github-config/ui/messages.ts"],
  [GITHUB_SIGN_IN_NOT_CONFIGURED, "github-config/ui/messages.ts"],
  [PRIVATE_APP_WHERE_HINT, "github-config/ui/messages.ts"],
  [INVITATION_LINK_LIFETIME, "workspaces/ui/messages.ts"],
  [FAIL_CLOSED_WARNING, "signup/ui/rule-copy.ts"],
  ...SIGN_UP_RULE_OPTIONS.map((option): readonly [string, string] => [
    option.text,
    "signup/ui/rule-copy.ts",
  ]),
  ...TENANCY_OPTIONS.map((option): readonly [string, string] => [
    option.text,
    "signup/ui/tenancy-copy.ts",
  ]),
  ...Object.values(PROJECT_STATE_NOTICE).flatMap(
    (notice): ReadonlyArray<readonly [string, string]> => [
      [notice.title, "projects/ui/messages.ts"],
      [notice.detail, "projects/ui/messages.ts"],
    ],
  ),
  [CROSS_SITE_REQUEST, "copy/messages.ts"],
  [CROSS_SITE_REQUEST_RELOAD_PAGE, "copy/messages.ts"],
  [REQUEST_NOT_UNDERSTOOD, "copy/messages.ts"],
  [UNAVAILABLE, "copy/messages.ts"],
  [TOO_MANY_ATTEMPTS, "copy/messages.ts"],
  [NOT_AVAILABLE_TO_YOU, "copy/messages.ts"],
  [INVALID_VALUES, "copy/messages.ts"],
  [ROLE_NOT_ALLOWED, "copy/messages.ts"],
  [SESSION_ENDED, "copy/messages.ts"],
  [INVALID_EMAIL, "copy/messages.ts"],
  [ENTRIES_REQUIRED, "copy/messages.ts"],
  [ENTRY_INVALID, "copy/messages.ts"],
  [TOO_MANY_ENTRIES, "copy/messages.ts"],
];

/** The message modules: where copy lives, one owner per fact (#169, the plan's duplication table). */
const MESSAGE_MODULES = [
  "admin/ui/messages.ts",
  "auth/login-errors.ts",
  "auth/password-policy.ts",
  "config-status/notices.ts",
  "copy/messages.ts",
  "github-config/ui/messages.ts",
  "installation-binding/ui/messages.ts",
  "llm/ui/messages.ts",
  "manual-reviews/ui/messages.ts",
  "projects/ui/messages.ts",
  "review-settings/ui/messages.ts",
  "runs/error-copy.ts",
  "runs/run-status.ts",
  "runs/ui/poll-messages.ts",
  "secrets/messages.ts",
  "setup/ui/messages.ts",
  "signup/ui/messages.ts",
  "signup/ui/rule-copy.ts",
  "signup/ui/tenancy-copy.ts",
  "ui/transport-messages.ts",
  "workspaces/ui/messages.ts",
  "workspaces/ui/role-copy.ts",
];

const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

/** Every paragraph written as a string literal in one message module, normalized for comparison. */
function paragraphs(modulePath: string): string[] {
  const text = readFileSync(`${APP_SRC}${modulePath}`, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(STRING_LITERAL)) {
    const raw = match[1] ?? match[2] ?? "";
    if (raw.includes("${")) continue; // a value the page assembles, not a paragraph of its own
    const paragraph = raw.replace(/\s+/g, " ").trim();
    if (paragraph.length < 20 || !paragraph.includes(" ")) continue;
    found.push(paragraph);
  }
  return found;
}

describe("the owners of the consolidated copy", () => {
  // #169-T01
  it("has one module for the password rule, used by the sign-up and the reset form", () => {
    expect(filesContaining(PASSWORD_RULE_HINT)).toEqual([
      "auth/password-policy.ts",
    ]);
    expect(filesContaining(PASSWORDS_DO_NOT_MATCH)).toEqual([
      "auth/password-policy.ts",
    ]);
    // The numbers in the copy are the numbers the server checks.
    expect(PASSWORD_RULE_HINT).toContain(String(PASSWORD_MIN_LENGTH));
    expect(PASSWORD_RULE_HINT).toContain(String(PASSWORD_MAX_LENGTH));
    for (const form of [
      "signup/ui/sign-up-form.tsx",
      "auth/ui/reset-password-form.tsx",
    ]) {
      const source = readFileSync(`${APP_SRC}${form}`, "utf8");
      expect(source).toContain("PASSWORD_RULE_HINT");
      expect(source).toContain("PASSWORDS_DO_NOT_MATCH");
    }
  });

  // #169-T02
  it("has one module for the notice about a secret saved with another APP_SECRET", () => {
    expect(filesContaining(UNREADABLE_SECRET_CAUSE)).toEqual([
      "secrets/messages.ts",
    ]);
  });

  // #169-T03
  it("has one module for the text that GitHub is not set up yet", () => {
    expect(filesContaining(GITHUB_NOT_CONFIGURED_TITLE)).toEqual([
      "config-status/notices.ts",
    ]);
    expect(filesContaining(GITHUB_NOT_CONFIGURED_COPY)).toEqual([
      "config-status/notices.ts",
    ]);
  });

  // #169-T04
  it("has one module for the invitation that works once, for 7 days", () => {
    expect(filesContaining(INVITATION_LINK_LIFETIME)).toEqual([
      "workspaces/ui/messages.ts",
    ]);
  });

  // #169-T05
  it("gives every consolidated sentence exactly one owner in the whole source", () => {
    for (const [sentence, owner] of CONSOLIDATED) {
      expect(filesContaining(sentence), sentence).toEqual([owner]);
    }
  });
});

describe("the message modules", () => {
  // #169-T05
  it("never repeat a paragraph in two modules", () => {
    const owners = new Map<string, Set<string>>();
    for (const modulePath of MESSAGE_MODULES) {
      for (const paragraph of paragraphs(modulePath)) {
        const modules = owners.get(paragraph) ?? new Set<string>();
        modules.add(modulePath);
        owners.set(paragraph, modules);
      }
    }
    const duplicated = [...owners.entries()]
      .filter(([, modules]) => modules.size > 1)
      .map(
        ([paragraph, modules]) => `${[...modules].join(", ")}: ${paragraph}`,
      );
    expect(duplicated).toEqual([]);
  });
});
