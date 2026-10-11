// SPDX-License-Identifier: Apache-2.0

// Pins down the rule that the proxy is not the only guard: a Server Function is a POST to the page
// it lives on, so the proxy may let it through (a public page) or stop seeing it (a changed
// matcher). Every route handler that is not public, and every file of Server Functions, must
// therefore call `requireUser()` itself. The files that are public on purpose are listed here.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_DIRECTORY,
  concretePath,
  discoverRoutes,
} from "../test-support/routes.ts";
import { isPublicPath } from "./access.ts";

const SRC = join(APP_DIRECTORY, "..");

// Server Functions that need no user: they start the sign in and end a session.
const PUBLIC_SERVER_FUNCTION_FILES = ["auth/actions.ts"];

function callsRequireUser(source: string): boolean {
  return /\brequireUser\(\)/.test(source);
}

function isServerFunctionFile(source: string): boolean {
  return /^\s*(["'])use server\1/m.test(
    source.split("\n").slice(0, 5).join("\n"),
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

describe("the second guard behind the proxy", () => {
  it("is called by every route handler that is not public", () => {
    const unguarded = discoverRoutes()
      .filter(({ file }) => /[\\/]route\.[a-z]+$/.test(file))
      .filter(({ route }) => !isPublicPath(concretePath(route)))
      .filter(({ file }) => !callsRequireUser(readFileSync(file, "utf8")))
      .map(({ route }) => route);

    expect(unguarded).toEqual([]);
  });

  it("is called by every file of Server Functions, except the public ones listed here", () => {
    const unguarded = sourceFiles(SRC)
      .filter((file) => isServerFunctionFile(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .filter((file) => !PUBLIC_SERVER_FUNCTION_FILES.includes(file))
      .filter(
        (file) => !callsRequireUser(readFileSync(join(SRC, file), "utf8")),
      );

    expect(unguarded).toEqual([]);
  });

  it("recognizes a Server Function file and a call to requireUser", () => {
    expect(
      isServerFunctionFile('"use server";\nexport async function a() {}'),
    ).toBe(true);
    expect(
      isServerFunctionFile("import x from 'y';\nexport const a = 1;"),
    ).toBe(false);
    expect(callsRequireUser("const user = await requireUser();")).toBe(true);
    expect(callsRequireUser("// requireUser is mentioned only")).toBe(false);
  });

  it("knows the public Server Function files exist", () => {
    for (const file of PUBLIC_SERVER_FUNCTION_FILES) {
      expect(isServerFunctionFile(readFileSync(join(SRC, file), "utf8"))).toBe(
        true,
      );
    }
  });
});
