// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitKnown, pathsChanged } from "./git.ts";

let dir: string;
const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
const commitFile = (path: string, content: string): string => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git("add", "-A");
  git("commit", "-q", "-m", `change ${path}`);
  return git("rev-parse", "HEAD");
};

let first: string;
let docsOnly: string;
let runnerChanged: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cr-snapshot-git-"));
  git("init", "-q", "-b", "main");
  first = commitFile("runner/src/a.py", "1");
  docsOnly = commitFile("docs/x.md", "2");
  runnerChanged = commitFile("runner/src/a.py", "3");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the git questions of the snapshot decision", () => {
  // #403-T13
  it("knows a commit of the clone and not one that is missing", async () => {
    expect(await commitKnown(dir, first)).toBe(true);
    expect(await commitKnown(dir, "f".repeat(40))).toBe(false);
  });

  // #403-T13
  it("says no when only other paths changed between two commits", async () => {
    expect(
      await pathsChanged(dir, first, docsOnly, ["runner", "docker/sandbox"]),
    ).toBe(false);
  });

  // #403-T13
  it("says yes when a listed path changed, in a file or a folder, even through other commits", async () => {
    expect(await pathsChanged(dir, docsOnly, runnerChanged, ["runner"])).toBe(
      true,
    );
    expect(await pathsChanged(dir, first, runnerChanged, ["runner/src"])).toBe(
      true,
    );
  });

  // #403-T13
  it("says no for the same commit, and ignores a path that does not exist at either commit", async () => {
    expect(
      await pathsChanged(dir, runnerChanged, runnerChanged, ["runner"]),
    ).toBe(false);
    expect(await pathsChanged(dir, first, docsOnly, ["no/such/path"])).toBe(
      false,
    );
  });

  // #403-T13
  it("fails, rather than say no, when a commit is not in the clone", async () => {
    await expect(
      pathsChanged(dir, "f".repeat(40), first, ["runner"]),
    ).rejects.toThrow();
  });

  // #403-T13
  it("takes a commit as a commit, never as an option", async () => {
    expect(await commitKnown(dir, "--output=/tmp/x")).toBe(false);
    await expect(
      pathsChanged(dir, "--help", first, ["runner"]),
    ).rejects.toThrow();
  });
});
