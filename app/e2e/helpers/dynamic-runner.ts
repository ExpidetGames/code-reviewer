// SPDX-License-Identifier: Apache-2.0

// Starts the real Dynamic runner of the privileged e2e lane (#253) the way compose.dynamic.yml starts it:
// the root supervisor with exactly the capabilities of that file and no-new-privileges, in the environment of
// that file, polling an app under test. Nothing of the advertisement is added here: the runner installs the
// engine user's static network rules, drops NET_ADMIN and SETPCAP, runs its startup self-check on the
// pinned OpenCode and `rg` where the image has them, and only if all of it passes does it send `opencode`
// in its claims. The lane reads what the runner logged about it and nothing else (`advertisementOf`).
//
// Needs root and the lane's namespaces (runner/scripts/run_dynamic_e2e.sh); `preflight` says what is missing.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { e2eEnv } from "./e2e-env";

const RUNNER_DIRECTORY = resolve(process.cwd(), "../runner");
const WRAPPER = resolve(
  process.cwd(),
  "../fakes/pr-agent/run_job_against_fake_llm.py",
);

/**
 * `cap_add` of compose.dynamic.yml, as setpriv names them: the supervisor's six and the two that exist for the
 * startup of the container only. app/src/test-support/dynamic-lane-runner.test.ts keeps this equal to the file.
 */
export const PRODUCTION_CAPABILITIES = [
  "chown",
  "dac_override",
  "fowner",
  "kill",
  "setgid",
  "setuid",
  "setpcap",
  "net_admin",
] as const;

/** Waits for a condition, looking every 100 ms; fails with `what` when it does not hold in time. */
async function until(
  what: string,
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${what}.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The engine user of the Dynamic image: its processes must not outlive the runner. */
const ENGINE_UID = 10101;

/** One argument of `PR_AGENT_COMMAND`, which the runner splits like a shell does. */
function quoted(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

/** The command that runs a program with the capabilities of the container and no others. */
export function runnerCommand(program: string): {
  command: string;
  args: string[];
} {
  return {
    command: "setpriv",
    args: [
      `--bounding-set=-all,${PRODUCTION_CAPABILITIES.map((name) => `+${name}`).join(",")}`,
      "--inh-caps=-all",
      "--no-new-privs",
      program,
    ],
  };
}

export type RunnerEnvironmentOptions = {
  home: string;
  /** The app to poll. */
  appUrl: string;
  /** The `llm.baseUrl` the jobs get, the address of the fake LLM. */
  llmBaseUrl: string;
  python: string;
  wrapper: string;
  runnerToken: string;
};

/**
 * The environment of `runner-dynamic` in compose.dynamic.yml, closed like a container's. The one addition is
 * the job command that adds the address of the fake LLM to the job (the app has no setting for it, see
 * fakes/pr-agent/run_job_against_fake_llm.py); the real job entry point validates the job as ever.
 */
export function runnerEnvironment(
  options: RunnerEnvironmentOptions,
): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: options.home,
    TMPDIR: tmpdir(),
    LANG: "C.UTF-8",
    RUNNER_API_URL: options.appUrl,
    RUNNER_TOKEN: options.runnerToken,
    RUNNER_ID: "e2e-dynamic-runner",
    // The loop is root; the Diff jobs it would run are dropped to this user (none run in this lane).
    RUNNER_DIFF_JOB_USER: "10001:10001",
    RUNNER_CONCURRENCY: "1",
    RUNNER_POLL_INTERVAL_SECONDS: "0.2",
    RUNNER_JOB_TIMEOUT_SECONDS: "240",
    RUNNER_SHUTDOWN_GRACE_SECONDS: "5",
    RUNNER_DYNAMIC_CAPABILITIES: JSON.stringify({
      tool_choice_required: true,
      structured_output: true,
      max_output_tokens: 4096,
    }),
    PR_AGENT_COMMAND: [options.python, options.wrapper, options.llmBaseUrl]
      .map(quoted)
      .join(" "),
  };
}

export type Advertisement =
  | { state: "pending" }
  | { state: "advertised" }
  | { state: "refused"; line: string };

/** What the runner's own log says about `opencode`; the first verdict counts. */
export function advertisementOf(output: string): Advertisement {
  for (const line of output.split("\n")) {
    if (line.includes("Dynamic Review: opencode is advertised"))
      return { state: "advertised" };
    if (
      line.includes("Dynamic Review: opencode is not advertised") ||
      line.includes("cannot start:")
    )
      return { state: "refused", line: line.trim() };
  }
  return { state: "pending" };
}

/** The processes of the engine user, `pid command` per line. */
export function engineProcesses(): string[] {
  const done = spawnSync("ps", ["-u", String(ENGINE_UID), "-o", "pid=,args="], {
    encoding: "utf8",
  });
  // ps exits 1 when no process matches.
  return done.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export type DynamicRunner = {
  /** Everything the runner wrote to stdout and stderr so far (its log and the jobs' diagnostics). */
  output(): string;
  /** Waits for the runner's verdict on its self-check; throws with the logged reason if it is a refusal. */
  waitForAdvertisement(): Promise<void>;
  /** SIGTERM, then SIGKILL; fails if a process of the engine user is left; removes the runner's home. */
  stop(): Promise<void>;
};

export async function startDynamicRunner(options: {
  appUrl: string;
  llmBaseUrl: string;
}): Promise<DynamicRunner> {
  const python = join(RUNNER_DIRECTORY, ".venv/bin/python");
  const program = join(RUNNER_DIRECTORY, ".venv/bin/code-reviewer-runner");
  if (!existsSync(program))
    throw new Error(
      `The runner is not installed (${program} is missing): run "make install" or "uv sync --locked" in runner/.`,
    );

  const home = mkdtempSync(join(tmpdir(), "cr-lane-runner-"));
  const { command, args } = runnerCommand(program);
  const child: ChildProcess = spawn(command, args, {
    cwd: home,
    env: runnerEnvironment({
      home,
      appUrl: options.appUrl,
      llmBaseUrl: options.llmBaseUrl,
      python,
      wrapper: WRAPPER,
      runnerToken: e2eEnv.runnerToken,
    }) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      resolveExit();
    });
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;

  // A worker that ends without `stop()` must not leave a root runner polling the app. (The lane's PID
  // namespace ends everything when the lane ends; this is for a run of the config outside of it.)
  const onExit = () => {
    if (isRunning()) child.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  };
  process.on("exit", onExit);

  return {
    output: () => output,
    async waitForAdvertisement() {
      await until(
        "the runner's verdict on its startup self-check",
        () => advertisementOf(output).state !== "pending" || !isRunning(),
        60_000,
      );
      const verdict = advertisementOf(output);
      if (verdict.state === "refused")
        throw new Error(
          `The runner does not advertise opencode: ${verdict.line}`,
        );
      if (verdict.state !== "advertised")
        throw new Error(
          `The runner ended before its self-check said anything about opencode. Its output:\n${output.slice(-2000)}`,
        );
    },
    async stop() {
      process.removeListener("exit", onExit);
      try {
        if (isRunning()) {
          child.kill("SIGTERM");
          const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
          await exited;
          clearTimeout(killer);
        }
        await until(
          "the processes of the engine user to be gone after the runner",
          () => engineProcesses().length === 0,
          15_000,
        ).catch((error: unknown) => {
          throw new Error(
            `${String(error)} Left: ${engineProcesses().join("; ")}`,
          );
        });
      } finally {
        // For the report of a failing run: the runner's log is not in any other file.
        mkdirSync("test-results", { recursive: true });
        writeFileSync("test-results/dynamic-runner.log", output);
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
