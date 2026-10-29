// SPDX-License-Identifier: LicenseRef-Proprietary

// Proves that the network guard of the privileged Dynamic e2e lane (#253) sees every kind of process
// (e2e/dynamic/guard.nft is in the kernel of the lane's network namespace). For each user of the lane, a real
// process tries to connect to a reserved address that nothing answers on (TEST-NET-1): the pinned OpenCode
// as the engine user, Git as the Diff job user, and helper processes of two other runtimes as root. Each
// attempt must be counted, and must fail at once for the process that made it. The counters that fail a
// test (anything that is not loopback) are read by the journey, and a connection to a fake on loopback
// moves none of them. Which counter fails a test is proven without root in
// src/test-support/dynamic-lane-guard.test.ts.
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  CONTROL_PREFIX,
  assertGuardQuiet,
  readDns,
  readGuard,
  type ControlWho,
} from "../helpers/dynamic-lane-guard";
import { OPENCODE_PATH } from "../helpers/dynamic-preflight";
import { waitUntil } from "../helpers/wait-until";

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

/** `setpriv` with the user, a closed environment like the engine's, and the command. */
function asUserCommand(
  user: { uid: number; gid: number },
  home: string,
  command: string,
  args: string[],
): string[] {
  return [
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
    // What the runner gives the engine (dynamic_review/config.py): no downloads, no catalog fetch.
    "OPENCODE_DISABLE_MODELS_FETCH=true",
    "OPENCODE_DISABLE_AUTOUPDATE=true",
    "OPENCODE_DISABLE_LSP_DOWNLOAD=true",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS=true",
    "OPENCODE_DISABLE_TELEMETRY=true",
    `XDG_CONFIG_HOME=${home}/.config`,
    `XDG_DATA_HOME=${home}/.local/share`,
    `XDG_CACHE_HOME=${home}/.cache`,
    `XDG_STATE_HOME=${home}/.local/state`,
    command,
    ...args,
  ];
}

/**
 * Runs a command as a user of the lane and waits for it to end. Resolves with the exit status, never
 * rejects for a failing command: a failure is what the attempt is meant to end in.
 */
async function asUser(
  user: { uid: number; gid: number },
  home: string,
  command: string,
  args: string[],
): Promise<{ status: number | string; stderr: string }> {
  try {
    await run("setpriv", asUserCommand(user, home, command, args), {
      // The home is the one directory every user of the lane can enter: the working directory of the
      // test process is the checkout of the CI user.
      cwd: home,
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string };
    return {
      status: failure.code ?? "failed",
      stderr: String(failure.stderr ?? "").slice(-1500),
    };
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

  async function countedFor(
    who: ControlWho,
    attempt: () => Promise<{ status: number | string; stderr: string }>,
  ) {
    const before = readGuard();
    const dnsBefore = readDns();
    const done = await attempt();
    const after = readGuard();
    // The addresses of an attempt are literal: the engine user looked up no name (root's counter is left out, the
    // lane's own programs ask for a name now and then while a test runs).
    expect(
      readDns().queries.engine,
      "name lookups of the engine user during the attempt",
    ).toBe(dnsBefore.queries.engine);
    expect(
      after.controls[who] - before.controls[who],
      `the attempt ended with ${JSON.stringify(done)}`,
    ).toBeGreaterThan(0);
    // Whatever the attempt did, it did not go through a counter that fails a test.
    expect(after.violations).toEqual(before.violations);
    return done;
  }

  // #253-G05
  test("counts a helper of the engine user when it reaches for an address that is not a fake", async () => {
    const done = await countedFor("engine", () =>
      asUser(ENGINE, home, "bash", [
        "-c",
        `exec 3<>/dev/tcp/${CONTROL_PREFIX.host}/80`,
      ]),
    );

    expect(done.status).not.toBe(0);
  });

  // #253-G05
  test("counts the pinned OpenCode, run as the engine user, when it reaches for an address that is not a fake", async () => {
    // The engine starts slowly the first time; the condition that matters is the counter, so the test waits
    // for that and then ends the process.
    const before = readGuard();
    const dnsBefore = readDns();
    const child = spawn(
      "setpriv",
      asUserCommand(ENGINE, home, OPENCODE_PATH, [
        "run",
        "--attach",
        `http://${CONTROL_PREFIX.host}:9`,
        "--dir",
        home,
        "hello",
      ]),
      { cwd: home, stdio: "ignore" },
    );
    try {
      await waitUntil(
        "OpenCode to try to reach an address that is not a fake",
        () => readGuard().controls.engine > before.controls.engine,
        90_000,
      );
    } finally {
      child.kill("SIGKILL");
    }

    expect(readGuard().violations).toEqual(before.violations);
    expect(
      readDns().queries.engine,
      "name lookups of the engine user while OpenCode ran",
    ).toBe(dnsBefore.queries.engine);
  });

  // #714-T02
  test("counts a DNS-sized packet of the engine user on loopback in the control of the name lookups, which no name check fails", async () => {
    const before = readGuard();
    const dnsBefore = readDns();

    // Nothing answers on 127.0.0.2: the packet is the control, not a lookup of the lane's resolver (a real lookup of the
    // engine user would fail the lane at its end, by design; the gate logic is proven in src/test-support).
    await asUser(ENGINE, home, "bash", [
      "-c",
      "exec 3<>/dev/udp/127.0.0.2/53; echo control >&3",
    ]);

    const dnsAfter = readDns();
    expect(dnsAfter.controlEngine - dnsBefore.controlEngine).toBeGreaterThan(0);
    expect(dnsAfter.queries).toEqual(dnsBefore.queries);
    expect(readGuard()).toEqual(before);
  });

  // #253-G06
  test("counts Git, run as the Diff job user, when it reaches for an address that is not a fake", async () => {
    const done = await countedFor("job", () =>
      asUser(JOB, home, "git", [
        "ls-remote",
        `http://${CONTROL_PREFIX.host}/nobody/nothing.git`,
      ]),
    );

    expect(done.status).not.toBe(0);
  });

  // #253-G07
  test("counts helper processes of other runtimes, run as root, when they reach for an address that is not a fake", async () => {
    const shell = await countedFor("root", () =>
      asUser(ROOT, home, "bash", [
        "-c",
        `exec 3<>/dev/tcp/${CONTROL_PREFIX.host}/80`,
      ]),
    );
    const node = await countedFor("root", () =>
      asUser(ROOT, home, process.execPath, [
        "-e",
        `require("node:net").connect(80, "${CONTROL_PREFIX.host}").on("error", () => process.exit(7))`,
      ]),
    );

    expect(shell.status).not.toBe(0);
    expect(node.status).toBe(7);
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
    assertGuardQuiet();
  });
});
