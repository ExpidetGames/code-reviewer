// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the Git part of the fake GitHub (fakes/github/git-http.ts) over real HTTP with the real Git
// client: the smart HTTP upload-pack of a repository the test registered, the pull request refs, and what
// the runner's Git transport relies on (an installation token as the Basic password, nothing without one,
// nothing for a repository the token does not reach). The Dynamic e2e lane (e2e/dynamic, #253) has the real
// runner check out a pull request from this endpoint, so a wrong fake fails here first.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGitRepository } from "../../../../../fakes/github/git-fixture.ts";
import {
  startGithubFake,
  type FakePullRequest,
} from "../../../../../fakes/github/server.ts";
import { createGithubAppClient } from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import {
  testGithubAppEnv,
  TEST_APP_ID,
  testAppKeys,
} from "../../../test-support/github-app.ts";
import { cleanUpAfterTest } from "../../../test-support/test-database.ts";

const OWNER = { login: "acme", id: 5001, type: "Organization" } as const;
const WIDGETS = { id: 7001, fullName: "acme/widgets" };
const OTHER = { id: 7002, fullName: "acme/other" };

async function setup() {
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
    appSlug: "code-reviewer-test",
    selfLinks: true,
  });
  cleanUpAfterTest(() => fake.close());
  fake.addInstallation({ id: 4242, account: OWNER });
  fake.setRepositories(4242, [WIDGETS, OTHER]);
  const directory = mkdtempSync(join(tmpdir(), "cr-fake-git-"));
  cleanUpAfterTest(async () => {
    await Promise.resolve();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = createGitRepository(join(directory, "widgets"));
  const base = repository.commit(
    { "README.md": "base\n", "src/lookup.py": "def lookup():\n    return 1\n" },
    "Base",
  );
  repository.branch("feature");
  const head = repository.commit({ "src/app.py": "print('hi')\n" }, "Feature");
  repository.setRef("refs/heads/main", base);
  repository.setRef("refs/pull/7/head", head);
  fake.addGitRepository(WIDGETS.fullName, repository.path);
  const pull: FakePullRequest = {
    number: 7,
    title: "Add an app",
    state: "open",
    headSha: head,
    headRef: "feature",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  };
  fake.addPullRequest(WIDGETS.fullName, pull);
  const client = createGithubAppClient({
    config: loadGithubAppConfig(
      testGithubAppEnv({
        GITHUB_API_BASE_URL: fake.baseUrl,
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
      }),
    ),
  });
  const mint = async (repositoryIds: number[]) =>
    (
      await client.mintInstallationToken("4242", {
        repositoryIds,
        permissions: { contents: "read", metadata: "read" },
      })
    ).token;
  return { fake, repository, base, head, mint, directory };
}

/** The runner's header: Basic with the user `x-access-token` and the installation token. */
function basic(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

const run = promisify(execFile);

// Asynchronous on purpose: the fake runs in this very process, and a blocked event loop cannot answer.
async function git(
  directory: string,
  token: string,
  ...args: string[]
): Promise<string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const done = await run(
    "git",
    ["-c", `http.extraHeader=Authorization: ${basic(token)}`, ...args],
    {
      cwd: directory,
      encoding: "utf8",
      // Next's types make NODE_ENV a required variable; Git does not read it.
      env: environment as NodeJS.ProcessEnv,
    },
  );
  return done.stdout;
}

describe("the Git endpoint of the fake GitHub", () => {
  // #253-F01
  it("advertises the branch and the pull request ref of a registered repository to an installation token", async () => {
    const { fake, base, head, mint, directory } = await setup();
    const token = await mint([WIDGETS.id]);

    const refs = await git(
      directory,
      token,
      "ls-remote",
      `${fake.baseUrl}/acme/widgets.git`,
    );

    expect(refs).toContain(`${base}\trefs/heads/main`);
    expect(refs).toContain(`${head}\trefs/pull/7/head`);
  });

  // #253-F01
  it("lets the real Git client fetch the pull request head, by ref and by object name", async () => {
    const { fake, base, head, mint, directory } = await setup();
    const token = await mint([WIDGETS.id]);
    const clone = join(directory, "clone");
    execFileSync("git", ["init", "--quiet", clone]);

    await git(
      clone,
      token,
      "fetch",
      "--quiet",
      `${fake.baseUrl}/acme/widgets.git`,
      "refs/pull/7/head",
    );
    await git(
      clone,
      token,
      "fetch",
      "--quiet",
      `${fake.baseUrl}/acme/widgets.git`,
      base,
    );

    expect(
      execFileSync("git", ["-C", clone, "show", `${head}:src/app.py`], {
        encoding: "utf8",
      }),
    ).toBe("print('hi')\n");
    expect(
      execFileSync("git", ["-C", clone, "cat-file", "-t", base], {
        encoding: "utf8",
      }).trim(),
    ).toBe("commit");
  });

  // #253-F02
  it("answers 401 without a valid installation token and records the token it saw", async () => {
    const { fake, mint } = await setup();
    const token = await mint([WIDGETS.id]);
    const url = `${fake.baseUrl}/acme/widgets.git/info/refs?service=git-upload-pack`;

    const none = await fetch(url);
    const wrong = await fetch(url, {
      headers: { authorization: basic("not-a-token") },
    });
    const right = await fetch(url, {
      headers: { authorization: basic(token) },
    });

    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
    expect(right.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(fake.seenCredentials()).toContain(token);
  });

  // #253-F02
  it("answers 404 for a repository the token does not reach or nobody registered", async () => {
    const { fake, mint } = await setup();
    const token = await mint([OTHER.id]);

    const unreachable = await fetch(
      `${fake.baseUrl}/acme/widgets.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: basic(token) } },
    );
    const unregistered = await fetch(
      `${fake.baseUrl}/acme/other.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: basic(token) } },
    );

    expect(unreachable.status).toBe(404);
    expect(unregistered.status).toBe(404);
  });

  // #253-F03
  it("registers a repository through the control endpoint of the fake that runs as its own process", async () => {
    const { fake, repository, mint, directory } = await setup();
    const token = await mint([OTHER.id]);
    const registered = await fetch(`${fake.baseUrl}/__fake/git-repositories`, {
      method: "POST",
      body: JSON.stringify({
        repository: OTHER.fullName,
        path: repository.path,
      }),
    });

    const refs = await git(
      directory,
      token,
      "ls-remote",
      `${fake.baseUrl}/acme/other.git`,
    );

    expect(registered.status).toBe(201);
    expect(refs).toContain("refs/pull/7/head");
  });

  // #253-F03
  it("keeps the fixture reproducible: the same files and message give the same commit", () => {
    const first = mkdtempSync(join(tmpdir(), "cr-fixture-a-"));
    const second = mkdtempSync(join(tmpdir(), "cr-fixture-b-"));
    cleanUpAfterTest(async () => {
      await Promise.resolve();
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    });

    const a = createGitRepository(join(first, "r")).commit(
      { "a.txt": "1\n" },
      "m",
    );
    const b = createGitRepository(join(second, "r")).commit(
      { "a.txt": "1\n" },
      "m",
    );

    expect(a).toBe(b);
    expect(readFileSync(join(first, "r", "a.txt"), "utf8")).toBe("1\n");
  });
});
