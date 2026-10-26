// SPDX-License-Identifier: LicenseRef-Proprietary

// Runs the jobs of an app under test with the real Worker (`code-reviewer-runner worker-once`), the way the hosted
// deployment does, without a Dispatcher: a small driver in the journey's process claims the next job like a
// Dispatcher does (with the dispatcher credential, asking for a per-job credential) and starts one Worker per job with
// the start document on stdin. Every job runs the real PR-Agent through the real job entry point; only the address of
// the fake LLM is added to the job on the way (see fakes/pr-agent/run_job_against_fake_llm.py), because the app has no
// setting for it. `stop()` ends the driver and gives the running job back, as a signal does a Worker.
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
export function tiktokenCacheDirectory(): string {
  return (
    process.env.TIKTOKEN_CACHE_DIR ||
    process.env.DATA_GYM_CACHE_DIR ||
    join(tmpdir(), "data-gym-cache")
  );
}

/** One argument of `PR_AGENT_COMMAND`, which the runner splits like a shell does. */
export function quoted(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

/** Fails with the way to fix it when the tiktoken encoding PR-Agent counts tokens with is not cached yet. */
export function assertTiktokenCache(): void {
  const cache = join(
    tiktokenCacheDirectory(),
    createHash("sha1").update(O200K_URL).digest("hex"),
  );
  if (!existsSync(cache))
    throw new Error(
      `The tiktoken cache is empty (${tiktokenCacheDirectory()}): run "uv run python scripts/prime_tiktoken_cache.py" in runner/ once (it needs the internet).`,
    );
}

export type RunnerProcess = {
  /** Everything the Workers wrote to stdout and stderr so far (their log and the jobs' diagnostics). */
  output(): string;
  /** Stops claiming, ends the running Worker with SIGTERM (SIGKILL if it does not end by itself) and removes the home. */
  stop(): Promise<void>;
};

type Claim = { job: { id: string; credential: string } } | null;

/** The next job as a Dispatcher claims it: 200 with the per-job credential, 204 for none. */
async function claimNext(appUrl: string): Promise<Claim> {
  const response = await fetch(`${appUrl}/api/runners/v1/claim`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${e2eEnv.runnerToken}`,
      "content-type": "application/json",
      "x-runner-id": "e2e-runner",
    },
    body: JSON.stringify({
      engines: ["pr-agent"],
      features: ["worker_credential"],
    }),
  });
  if (response.status === 204) return null;
  if (response.status !== 200)
    throw new Error(`The claim was answered with ${String(response.status)}.`);
  return (await response.json()) as Claim;
}

const pause = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

export async function startRunner(options: {
  /** The app to claim from. */
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
  assertTiktokenCache();

  // A home of its own: nothing of the developer's home reaches the jobs.
  const home = mkdtempSync(join(tmpdir(), "cr-e2e-runner-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "C.UTF-8",
    TIKTOKEN_CACHE_DIR: tiktokenCacheDirectory(),
    RUNNER_JOB_TIMEOUT_SECONDS: "150",
    PR_AGENT_COMMAND: [python, WRAPPER, options.llmBaseUrl]
      .map(quoted)
      .join(" "),
  };

  let output = "";
  let stopping = false;
  let running: ChildProcess | undefined;

  /** One Worker for one claimed job; resolves when it has ended. */
  function runWorker(claimed: NonNullable<Claim>): Promise<void> {
    const child = spawn(program, ["worker-once"], {
      cwd: home,
      // Next's types make NODE_ENV a required variable; the runner does not read it.
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    running = child;
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.end(
      JSON.stringify({
        appUrl: options.appUrl,
        jobId: claimed.job.id,
        credential: claimed.job.credential,
      }),
    );
    return new Promise<void>((done) => {
      child.once("exit", () => {
        running = undefined;
        done();
      });
    });
  }

  const driver = (async () => {
    while (!stopping) {
      let claimed: Claim;
      try {
        claimed = await claimNext(options.appUrl);
      } catch {
        // The app is not reachable (yet, or any more): ask again.
        await pause(500);
        continue;
      }
      if (claimed === null) {
        await pause(200);
        continue;
      }
      await runWorker(claimed);
    }
  })();

  // A driver that ends without `stop()` (a crash, process.exit, Ctrl+C) must not leave a Worker running: SIGTERM lets
  // it give its job back and exit.
  const onExit = () => {
    stopping = true;
    running?.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  };
  const signals = ["SIGINT", "SIGTERM"] as const;
  const onSignal = (signal: NodeJS.Signals) => {
    detach();
    onExit();
    // The default behavior was replaced by listening; restore it.
    process.kill(process.pid, signal);
  };
  const signalListeners = signals.map(
    (signal) => [signal, () => onSignal(signal)] as const,
  );
  process.on("exit", onExit);
  for (const [signal, listener] of signalListeners)
    process.on(signal, listener);
  function detach() {
    process.removeListener("exit", onExit);
    for (const [signal, listener] of signalListeners)
      process.removeListener(signal, listener);
  }

  return {
    output: () => output,
    async stop() {
      detach();
      stopping = true;
      try {
        const child = running;
        if (child !== undefined) {
          child.kill("SIGTERM");
          const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
          await driver;
          clearTimeout(killer);
        } else {
          await driver;
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
