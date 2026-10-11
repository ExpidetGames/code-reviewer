// Starts the real runner (the job loop, `code-reviewer-runner`) as a process of its own, polling an
// app under test, and stops it again. Every job it claims runs the real PR-Agent through the real
// job entry point; only the address of the fake LLM is added to the job on the way (see
// fakes/pr-agent/run_job_against_fake_llm.py), because the app has no setting for it.
//
// The runner comes from the Python environment of the runner project (`make install`, or
// `uv sync --locked` in runner/), and PR-Agent counts tokens with an encoding that has to be in
// tiktoken's cache already (`uv run python scripts/prime_tiktoken_cache.py` in runner/, needs the
// internet once). A missing piece is a failure with the way to fix it, never a skip.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { e2eEnv } from "./e2e-env";

const RUNNER_DIRECTORY = resolve(process.cwd(), "../runner");
const WRAPPER = resolve(
  process.cwd(),
  "../fakes/pr-agent/run_job_against_fake_llm.py",
);
// tiktoken names its cache file after the hash of the URL it downloads from.
const O200K_URL =
  "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken";

/** The directory tiktoken caches encodings in: where the job process will look. */
function tiktokenCacheDirectory(): string {
  return (
    process.env.TIKTOKEN_CACHE_DIR ||
    process.env.DATA_GYM_CACHE_DIR ||
    join(tmpdir(), "data-gym-cache")
  );
}

/** One argument of `PR_AGENT_COMMAND`, which the runner splits like a shell does. */
function quoted(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export type RunnerProcess = {
  /** Everything the runner wrote to stdout and stderr so far (its log and the jobs' diagnostics). */
  output(): string;
  /** SIGTERM, then SIGKILL if it does not end by itself. Removes the runner's home directory. */
  stop(): Promise<void>;
};

export async function startRunner(options: {
  /** The app to poll. */
  appUrl: string;
  /** The `llm.baseUrl` the jobs get, the address of the fake LLM. */
  llmBaseUrl: string;
}): Promise<RunnerProcess> {
  const python = join(RUNNER_DIRECTORY, ".venv/bin/python");
  const program = join(RUNNER_DIRECTORY, ".venv/bin/code-reviewer-runner");
  if (!existsSync(program))
    throw new Error(
      `The runner is not installed (${program} is missing): run "make install" or "uv sync --locked" in runner/.`,
    );
  const cache = join(
    tiktokenCacheDirectory(),
    createHash("sha1").update(O200K_URL).digest("hex"),
  );
  if (!existsSync(cache))
    throw new Error(
      `The tiktoken cache is empty (${tiktokenCacheDirectory()}): run "uv run python scripts/prime_tiktoken_cache.py" in runner/ once (it needs the internet).`,
    );

  // A home of its own: nothing of the developer's home reaches the jobs.
  const home = mkdtempSync(join(tmpdir(), "cr-e2e-runner-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "C.UTF-8",
    TIKTOKEN_CACHE_DIR: tiktokenCacheDirectory(),
    RUNNER_API_URL: options.appUrl,
    RUNNER_TOKEN: e2eEnv.runnerToken,
    RUNNER_ID: "e2e-runner",
    RUNNER_CONCURRENCY: "1",
    RUNNER_POLL_INTERVAL_SECONDS: "0.2",
    RUNNER_JOB_TIMEOUT_SECONDS: "150",
    RUNNER_SHUTDOWN_GRACE_SECONDS: "5",
    PR_AGENT_COMMAND: [python, WRAPPER, options.llmBaseUrl]
      .map(quoted)
      .join(" "),
  };
  const child: ChildProcess = spawn(program, [], {
    cwd: home,
    // Next's types make NODE_ENV a required variable; the runner does not read it.
    env: env as NodeJS.ProcessEnv,
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

  return {
    output: () => output,
    async stop() {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
          await exited;
          clearTimeout(killer);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
