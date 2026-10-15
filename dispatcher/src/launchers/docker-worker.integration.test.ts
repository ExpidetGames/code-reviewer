// SPDX-License-Identifier: Apache-2.0

// The `docker` stand-in of the hosted end-to-end lane (fakes/sandbox/bin/docker-worker.sh, #332) behind the local mode
// of the Sandbox double, with the flags the real renderer makes and a small program in place of the Worker. The lane's
// journeys rely on it being what a container is to the Worker: the entry mode and the start document arrive, the
// environment is closed, a flag it does not know is refused, a held container does not start, and the end of a container
// ends everything it runs, also a process in a session of its own. A stand-in that did less would let the journeys pass
// for the wrong reason, so it is proven here first.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxService } from "../../../fakes/sandbox/local.ts";
import { waitFor } from "../test-support/harness.ts";
import { renderDockerRunArguments } from "./container.ts";
import { WORKER_CONTAINER_SPEC } from "./container-spec.ts";

const DOCKER_WORKER = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fakes",
  "sandbox",
  "bin",
  "docker-worker.sh",
);
const IMAGE_ID = `sha256:${"e".repeat(64)}`;
const NAME = "code-reviewer-worker-00000000-0000-4000-8000-0000000000aa";
const START_DOCUMENT =
  '{"appUrl":"http://127.0.0.1:1","jobId":"j","credential":"crj_dummy"}\n';

let directory: string;
let records: string;
let worker: string;
let local: LocalSandboxService | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cr-docker-worker-"));
  records = join(directory, "records");
  worker = join(directory, "worker.sh");
  await mkdir(records);
  await mkdir(join(directory, "vms"));
});
afterEach(async () => {
  await local?.stopAll();
  local = undefined;
  await rm(directory, { recursive: true, force: true });
});

/** The program that stands in for the image's entry point: `<program> <mode>`. */
async function program(body: string): Promise<void> {
  await writeFile(worker, `#!/usr/bin/env bash\nset -u\n${body}\n`);
  await chmod(worker, 0o755);
}

async function vmWith(extra: Record<string, string> = {}) {
  local = new LocalSandboxService({
    dockerBin: DOCKER_WORKER,
    root: join(directory, "vms"),
    environment: {
      E2E_DOCKER_DIR: records,
      E2E_IMAGE_ID: IMAGE_ID,
      E2E_WORKER_COMMAND: worker,
      ...extra,
    },
  });
  return local.create({
    name: "vm-a",
    snapshotId: "snap",
    region: "fra1",
    vcpus: 1,
    timeoutMs: 60_000,
    tags: {},
    persistent: false,
  });
}

function flags(mode: string, environment: Record<string, string> = {}) {
  return renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
    image: IMAGE_ID,
    name: NAME,
    environment,
    command: [mode],
  });
}

function recorded(suffix: string): string[] {
  return readdirSync(records)
    .filter((file) => file.endsWith(suffix))
    .sort();
}

describe("the docker stand-in of the hosted lane", () => {
  // #332-T01
  it("runs the entry mode with the start document on stdin, records the flags and gives the Worker a closed environment", async () => {
    await program(
      `cat >"${directory}/stdin"; env | sort >"${directory}/env"; printf '%s' "$1" >"${directory}/mode"`,
    );
    const vm = await vmWith({
      E2E_WORKER_PASS_PR_AGENT_COMMAND: "python wrapper",
      E2E_LEAK: "must-not-reach-the-worker",
    });
    const started = await vm.start({
      label: "worker",
      cmd: "docker",
      args: flags("worker-once", { RUNNER_JOB_TIMEOUT_SECONDS: "180" }),
    });

    await started.writeStdin(START_DOCUMENT);
    await started.closeStdin();
    const result = await started.wait();

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(directory, "stdin"), "utf8")).toBe(
      START_DOCUMENT,
    );
    expect(await readFile(join(directory, "mode"), "utf8")).toBe("worker-once");
    const environment = await readFile(join(directory, "env"), "utf8");
    expect(environment).toContain("RUNNER_JOB_TIMEOUT_SECONDS=180");
    expect(environment).toContain("PR_AGENT_COMMAND=python wrapper");
    expect(environment).not.toContain("E2E_");
    expect(environment).not.toContain("must-not-reach-the-worker");
    const [argsFile] = recorded(".args");
    const recordedArguments = (
      await readFile(join(records, argsFile ?? ""), "utf8")
    ).split("\n");
    expect(recordedArguments).toEqual(
      expect.arrayContaining([
        "--cap-drop",
        "ALL",
        "--read-only",
        IMAGE_ID,
        "worker-once",
      ]),
    );
  });

  // #332-T09
  it("takes the names of E2E_WORKER_ONCE_UNSET out of worker-once and keeps them for probe, whose stdout is the verdict", async () => {
    await program(
      `env | sort >"${directory}/env-$1"; echo '{"engines":["pr-agent"],"reasons":[]}'`,
    );
    const environment = { RUNNER_DIFF_JOB_USER: "10001:10001" };
    const vm = await vmWith({ E2E_WORKER_ONCE_UNSET: "RUNNER_DIFF_JOB_USER" });

    await (
      await vm.start({
        label: "w",
        cmd: "docker",
        args: flags("worker-once", environment),
      })
    ).wait();
    const probe = await vm.exec({
      label: "p",
      cmd: "docker",
      args: flags("probe", environment),
    });

    expect(
      await readFile(join(directory, "env-worker-once"), "utf8"),
    ).not.toContain("RUNNER_DIFF_JOB_USER");
    expect(await readFile(join(directory, "env-probe"), "utf8")).toContain(
      "RUNNER_DIFF_JOB_USER=10001:10001",
    );
    expect(probe.stdout.trim()).toBe('{"engines":["pr-agent"],"reasons":[]}');
  });

  // #332-T01
  it("refuses a flag it does not know, like a daemon refuses one it does not", async () => {
    await program("true");
    const vm = await vmWith();

    const result = await vm.exec({
      label: "w",
      cmd: "docker",
      args: [
        ...flags("worker-once").slice(0, -2),
        "--privileged",
        IMAGE_ID,
        "worker-once",
      ],
    });

    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("unknown flag --privileged");
    expect(recorded(".args")).toEqual([]);
  });

  // #332-T08
  it("keeps the Worker from starting while the gate file exists and starts it when it is gone", async () => {
    await program(`touch "${directory}/started"`);
    const gate = join(directory, "gate");
    await writeFile(gate, "");
    const vm = await vmWith({ E2E_WORKER_GATE: gate });
    const started = await vm.start({
      label: "w",
      cmd: "docker",
      args: flags("worker-once"),
    });

    await waitFor(
      () => recorded(".args").length === 1,
      "the container to be recorded",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(join(directory, "started"))).toBe(false);
    await rm(gate);

    expect((await started.wait()).exitCode).toBe(0);
    expect(existsSync(join(directory, "started"))).toBe(true);
  });

  // #332-T06
  it("ends everything a container runs when it is removed, also a process in a session of its own", async () => {
    await program(
      `setsid bash -c 'echo $$ >"${directory}/lonely.pid"; exec sleep 60' &\necho $$ >"${directory}/main.pid"\nexec sleep 60`,
    );
    const vm = await vmWith();
    const started = await vm.start({
      label: "w",
      cmd: "docker",
      args: flags("worker-once"),
    });
    await waitFor(
      () =>
        existsSync(join(directory, "lonely.pid")) &&
        existsSync(join(directory, "main.pid")),
      "both processes to run",
    );
    const alive = (file: string) => {
      try {
        process.kill(Number(readFileSyncTrim(join(directory, file))), 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive("lonely.pid")).toBe(true);

    const removed = await vm.exec({
      label: "rm",
      cmd: "docker",
      args: ["rm", "--force", NAME],
    });

    expect(removed.exitCode).toBe(0);
    expect((await started.wait()).exitCode).toBe(137);
    await waitFor(
      () => !alive("lonely.pid") && !alive("main.pid"),
      "the processes to be gone",
    );
  });
});

function readFileSyncTrim(path: string): string {
  return readFileSync(path, "utf8").trim();
}
