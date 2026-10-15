// SPDX-License-Identifier: Apache-2.0

// Starts the Dispatcher of the hosted lane (#332) as a process of its own and gives the journeys what they need to
// steer and to look at it. The process is `dispatcher/src/test-support/hosted-e2e-main.ts`: the real Node entry and the
// real Sandbox-Launcher, over the local mode of the Sandbox double and `fakes/sandbox/bin/docker-worker.sh`, which runs
// the REAL Worker (`code-reviewer-runner worker-once`, or `probe`) as a local process where a container would be.
// "The Dispatcher is down" is this process not running; the app's address for it does not change.
//
// Everything the stand-in `docker` was asked is on disk (`hostedEnv.dockerDirectory`): the rendered flags of every
// container, the environment the Worker had, what it wrote to stderr (and stdout), its process id.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  appendFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { hostedEnv } from "./hosted-env";
import {
  assertTiktokenCache,
  quoted,
  tiktokenCacheDirectory,
} from "./runner-process";
import { waitUntil } from "./wait-until";

const DISPATCHER_DIRECTORY = resolve(process.cwd(), "../dispatcher");
const RUNNER_DIRECTORY = resolve(process.cwd(), "../runner");
const WRAPPER = resolve(
  process.cwd(),
  "../fakes/pr-agent/run_job_against_fake_llm.py",
);

const absolute = (path: string) => resolve(process.cwd(), path);

/** Every process below `pid` and `pid` itself, found before anything is killed (a dead process has no children). */
function killTree(pid: number): void {
  const table = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of table.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const all: number[] = [];
  const visit = (current: number) => {
    all.push(current);
    for (const child of children.get(current) ?? []) visit(child);
  };
  visit(pid);
  for (const target of all.reverse()) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** One `docker run` the stand-in saw: a container that was started (or, for the probe, a canary). */
export type Container = {
  /** The order the containers were started in. */
  index: number;
  /** The entry mode: `worker-once` or `probe`. */
  mode: string;
  /** The container's name, `code-reviewer-worker-<job id>` for a job. */
  name: string;
  /** The rendered flags and the image and mode, one argument each. */
  args: string[];
  /** The environment the Worker had, `NAME=value` per line. */
  environment: string;
  /** The Worker's process id; its tree is everything the container runs. */
  pid: number;
  /** What the Worker wrote to stderr (and to stdout, except the probe's verdict). Read when asked. */
  log(): string;
};

export type HostedDispatcher = {
  /** Everything the Dispatcher wrote to stdout and stderr so far. */
  output(): string;
  /** The containers started since the lane's records were last cleared, oldest first. */
  containers(): Container[];
  /** The Worker containers (`worker-once`) of one job. */
  workersOf(jobId: string): Container[];
  /** Keeps every Worker that starts from running until `holdWorkers(false)`: the VM is up, the Worker is not. */
  holdWorkers(on: boolean): void;
  /** The next `count` VM creations fail like a platform that is down. */
  failNextCreations(count: number): void;
  /** Ends the whole tree of a container at once, like a container that is killed. */
  killContainer(container: Container): void;
  /** SIGTERM, then SIGKILL. Everything the process started is stopped with it. */
  stop(): Promise<void>;
};

function readContainers(): Container[] {
  const directory = absolute(hostedEnv.dockerDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => /^run-\d+\.args$/.test(file))
    .sort()
    .map((file, index) => {
      const base = join(directory, file.slice(0, -".args".length));
      const args = readFileSync(`${base}.args`, "utf8").split("\n");
      args.pop();
      return {
        index,
        mode: args.at(-1) ?? "",
        name: readFileSync(`${base}.name`, "utf8"),
        args,
        environment: readFileSync(`${base}.env`, "utf8"),
        pid: Number(readFileSync(`${base}.pid`, "utf8")),
        log: () =>
          existsSync(`${base}.log`) ? readFileSync(`${base}.log`, "utf8") : "",
      };
    });
}

export async function startHostedDispatcher(options: {
  /** The `llm.baseUrl` the jobs get, the address of the fake LLM (the app has no setting for it). */
  llmBaseUrl: string;
  /** `pr-agent` (Diff only) or `pr-agent,opencode`. Default: Diff only. */
  engines?: string;
  /** The pool cap the Dispatcher sends with every claim. Default 1, the pool of the lane (the app's sweep keeps to it too). */
  maxRunning?: number;
  /** What the container of a Dynamic job is given (the operator's model descriptor and cost limit). */
  dynamic?: { capabilities: string; maxCostUsd: string };
  /** More variables for the process, for a lane that needs them (the privileged lane's wrapper). */
  environment?: Record<string, string>;
}): Promise<HostedDispatcher> {
  const python = join(RUNNER_DIRECTORY, ".venv/bin/python");
  const program = join(RUNNER_DIRECTORY, ".venv/bin/code-reviewer-runner");
  if (!existsSync(program))
    throw new Error(
      `The Worker is not installed (${program} is missing): run "make install" or "uv sync --locked" in runner/.`,
    );
  assertTiktokenCache();
  mkdirSync(absolute(hostedEnv.dockerDirectory), { recursive: true });
  mkdirSync(absolute(hostedEnv.controlDirectory), { recursive: true });
  const gate = absolute(`${hostedEnv.controlDirectory}/hold-workers`);
  rmSync(gate, { force: true });

  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: absolute(hostedEnv.directory),
    LANG: "C.UTF-8",
    // The Dispatcher's own settings (dispatcher/README.md, "Configuration").
    RUNNER_API_URL: hostedEnv.appUrl,
    RUNNER_TOKEN: hostedEnv.dispatcherToken,
    DISPATCHER_POOL_ID: hostedEnv.poolId,
    DISPATCHER_MAX_RUNNING: String(options.maxRunning ?? 1),
    DISPATCHER_ENGINES: options.engines ?? "pr-agent",
    DISPATCHER_JOB_TIMEOUT_SECONDS: "180",
    DISPATCHER_SIGNING_KEY_ID: hostedEnv.webhookKeyId,
    DISPATCHER_SIGNING_SECRET: hostedEnv.webhookSecret,
    DISPATCHER_SHUTDOWN_GRACE_SECONDS: "5",
    ...(options.dynamic === undefined
      ? {}
      : {
          RUNNER_DYNAMIC_CAPABILITIES: options.dynamic.capabilities,
          RUNNER_DYNAMIC_MAX_COST_USD: options.dynamic.maxCostUsd,
        }),
    // The test host and the `docker` stand-in (hosted-e2e-main.ts, docker-worker.sh).
    E2E_PORT: String(hostedEnv.dispatcherPort),
    E2E_IMAGE_ID: hostedEnv.imageId,
    E2E_CONTROL_DIR: absolute(hostedEnv.controlDirectory),
    E2E_DOCKER_DIR: absolute(hostedEnv.dockerDirectory),
    E2E_WORKER_COMMAND: program,
    E2E_WORKER_GATE: gate,
    // This lane is not root with capabilities, so its Workers serve Diff jobs (see docker-worker.sh); the privileged
    // lane (e2e/dynamic/) runs the Worker the way the container does and unsets nothing.
    E2E_WORKER_ONCE_UNSET: "RUNNER_DIFF_JOB_USER",
    // What the image carries itself and the container is not given: the job command that adds the address of the fake
    // LLM to the job, and the tiktoken encoding PR-Agent counts tokens with.
    E2E_WORKER_PASS_PR_AGENT_COMMAND: [python, WRAPPER, options.llmBaseUrl]
      .map(quoted)
      .join(" "),
    E2E_WORKER_PASS_TIKTOKEN_CACHE_DIR: tiktokenCacheDirectory(),
    ...options.environment,
  };

  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "src/test-support/hosted-e2e-main.ts",
    ],
    {
      cwd: DISPATCHER_DIRECTORY,
      // Next's types make NODE_ENV a required variable; the Dispatcher does not read it.
      env: environment as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const logFile = absolute(hostedEnv.logFiles.dispatcher);
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    // Every Dispatcher of the run appends to one file, for the journey that reads every log at the end.
    appendFileSync(logFile, chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;

  // A worker that ends without `stop()` must not leave a Dispatcher listening.
  const onExit = () => {
    if (isRunning()) child.kill("SIGKILL");
  };
  process.on("exit", onExit);

  const stop = async () => {
    process.removeListener("exit", onExit);
    if (!isRunning()) return;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    await exited;
    clearTimeout(killer);
  };

  try {
    await waitUntil(
      "the Dispatcher to listen",
      () => output.includes('"event":"listening"') || !isRunning(),
      30_000,
    );
    if (!isRunning())
      throw new Error(`The Dispatcher ended at start. Its output:\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    output: () => output,
    containers: readContainers,
    workersOf: (jobId) =>
      readContainers().filter(
        (container) =>
          container.mode === "worker-once" &&
          container.name === `code-reviewer-worker-${jobId}`,
      ),
    holdWorkers(on) {
      if (on) writeFileSync(gate, "");
      else rmSync(gate, { force: true });
    },
    failNextCreations(count) {
      writeFileSync(
        absolute(`${hostedEnv.controlDirectory}/fail-create`),
        String(count),
      );
    },
    killContainer(container) {
      killTree(container.pid);
    },
    stop,
  };
}
