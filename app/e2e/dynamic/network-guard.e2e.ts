// SPDX-License-Identifier: Apache-2.0

// Proves that the network guard of the privileged Dynamic e2e lane (#253) sees every kind of process
// (e2e/dynamic/guard.nft is in the kernel of the lane's network namespace). For each user of the lane, a real
// process tries to connect to a reserved address that nothing answers on (TEST-NET-1): the pinned OpenCode
// as the engine user, Git as the Diff job user, and helper processes of two other runtimes as root. Each
// attempt must be counted, and must fail at once for the process that made it. The counters that fail a
// test (anything that is not loopback) are read by the journey, and a connection to a fake on loopback
// moves none of them. Which counter fails a test is proven without root in
// src/test-support/dynamic-lane-guard.test.ts.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  CONTROL_PREFIX,
  assertNoExternalAttempts,
  readGuard,
  type ControlWho,
} from "../helpers/dynamic-lane-guard";
import { OPENCODE_PATH } from "../helpers/dynamic-preflight";

const run = promisify(execFile);
const ENGINE = { uid: 10101, gid: 10101 };
const JOB = { uid: 10001, gid: 10001 };
const ROOT = { uid: 0, gid: 0 };

/** A home directory every user of the lane can write to, removed afterwards. */
function sharedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cr-lane-guard-"));
  chmodSync(home, 0o777);
  return home;
}

/**
 * Runs a command as a user of the lane with a closed environment. Resolves with the exit status, never
 * rejects for a failing command: a failure is what the attempt is meant to end in.
 */
async function asUser(
  user: { uid: number; gid: number },
  home: string,
  command: string,
  args: string[],
): Promise<{ status: number | string }> {
  try {
    await run(
      "setpriv",
      [
        `--reuid=${String(user.uid)}`,
        `--regid=${String(user.gid)}`,
        "--clear-groups",
        "env",
        "-i",
        `HOME=${home}`,
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "NO_COLOR=1",
        "GIT_TERMINAL_PROMPT=0",
        "CI=1",
        command,
        ...args,
      ],
      { timeout: 60_000, killSignal: "SIGKILL" },
    );
    return { status: 0 };
  } catch (error) {
    const failure = error as { code?: number | string };
    return { status: failure.code ?? "failed" };
  }
}

test.describe("the network guard of the Dynamic lane", () => {
  let home = "";

  test.beforeAll(() => {
    home = sharedHome();
  });

  test.afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function countedFor(who: ControlWho, attempt: () => Promise<unknown>) {
    const before = readGuard();
    await attempt();
    const after = readGuard();
    expect(after.controls[who] - before.controls[who]).toBeGreaterThan(0);
    // Whatever the attempt did, it did not go through a counter that fails a test.
    expect(after.violations).toEqual(before.violations);
  }

  // #253-G05
  test("counts the pinned OpenCode, run as the engine user, when it reaches for an address that is not a fake", async () => {
    await countedFor("engine", async () => {
      const done = await asUser(ENGINE, home, OPENCODE_PATH, [
        "run",
        "--attach",
        `http://${CONTROL_PREFIX.host}:9`,
        "--dir",
        home,
        "hello",
      ]);
      expect(done.status).not.toBe(0);
    });
  });

  // #253-G06
  test("counts Git, run as the Diff job user, when it reaches for an address that is not a fake", async () => {
    await countedFor("job", async () => {
      const done = await asUser(JOB, home, "git", [
        "ls-remote",
        `http://${CONTROL_PREFIX.host}/nobody/nothing.git`,
      ]);
      expect(done.status).not.toBe(0);
    });
  });

  // #253-G07
  test("counts helper processes of other runtimes, run as root, when they reach for an address that is not a fake", async () => {
    await countedFor("root", async () => {
      const shell = await asUser(ROOT, home, "bash", [
        "-c",
        `exec 3<>/dev/tcp/${CONTROL_PREFIX.host}/80`,
      ]);
      expect(shell.status).not.toBe(0);
    });
    await countedFor("root", async () => {
      const node = await asUser(ROOT, home, process.execPath, [
        "-e",
        `require("node:net").connect(80, "${CONTROL_PREFIX.host}").on("error", () => process.exit(7))`,
      ]);
      expect(node.status).toBe(7);
    });
  });

  // #253-G08
  test("counts nothing when the same programs talk to the fakes on loopback", async () => {
    const before = readGuard();

    // The fake GitHub answers 401/404 to a Git request without a token, which is an answer: it was reached.
    const git = await asUser(JOB, home, "git", [
      "ls-remote",
      `${e2eEnv.githubUrl}/nobody/nothing.git`,
    ]);
    const shell = await asUser(ROOT, home, "bash", [
      "-c",
      `exec 3<>/dev/tcp/127.0.0.1/${String(e2eEnv.githubPort)}`,
    ]);

    expect(git.status).not.toBe(0);
    expect(shell.status).toBe(0);
    expect(readGuard()).toEqual(before);
    assertNoExternalAttempts(readGuard());
  });
});
