// SPDX-License-Identifier: Apache-2.0

// The privileged lane of the Sandbox-Launcher (#329-T09, T10): the local mode of the Sandbox double with a REAL Docker
// daemon and the REAL Worker image, against the fake App. It needs a daemon the user may use and an image built from
// the `sandbox` target (docker build --file runner/Dockerfile --target sandbox); it fails, naming the missing item,
// and never skips. `make test-sandbox-local` runs it; the CI job `sandbox-local` runs it for pull requests that touch
// the Dispatcher, the Worker image or the docker/ directory.
//
//   SANDBOX_LOCAL_IMAGE      the image reference built locally (required)
//   SANDBOX_LOCAL_APP_HOST   where a container reaches this machine; the docker0 gateway 172.17.0.1 by default.
//                            The network guard of the test must allow it (TEST_ALLOWED_HOSTS); the make target does.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { LocalSandboxService } from "../../../fakes/sandbox/local.ts";
import { createDispatcherCore } from "../core/dispatcher.ts";
import {
  DISPATCHER_TOKEN,
  recordingLogger,
  settingsFor,
  waitFor,
} from "../test-support/harness.ts";
import { createSandboxLauncher } from "./sandbox.ts";

const IMAGE = process.env.SANDBOX_LOCAL_IMAGE;
const APP_HOST = process.env.SANDBOX_LOCAL_APP_HOST ?? "172.17.0.1";
const WORKER_RESULT_TIMEOUT_MS = 180_000;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

let app: DispatcherAppFake;
let work: string | undefined;
let service: LocalSandboxService | undefined;

function workDirectory(): string {
  if (work === undefined)
    throw new Error("The work directory is not made yet.");
  return work;
}

beforeEach(async () => {
  if (IMAGE === undefined || IMAGE === "")
    throw new Error(
      "SANDBOX_LOCAL_IMAGE is not set: build the image (docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-worker:local .) and name it",
    );
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error("There is no Docker daemon this user may use.");
  }
  work = await mkdtemp(join(tmpdir(), "cr-privileged-"));
  app = await startDispatcherAppFake({
    host: "0.0.0.0",
    dispatcherToken: DISPATCHER_TOKEN,
  });
});
afterEach(async () => {
  await service?.stopAll();
  service = undefined;
  await app?.close();
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

/** A `docker` that logs its arguments and runs the real one, so the test can read the flags that were used. */
async function loggingDocker(): Promise<{ bin: string; log: string }> {
  const bin = join(workDirectory(), "docker-logged.sh");
  const log = join(workDirectory(), "docker-args.log");
  await writeFile(
    bin,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\nexec docker "$@"\n`,
  );
  await chmod(bin, 0o755);
  return { bin, log };
}

function build(bin: string) {
  const imageId = docker(
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    IMAGE ?? "",
  ).trim();
  service = new LocalSandboxService({ dockerBin: bin, root: workDirectory() });
  const logger = recordingLogger();
  const port = new URL(app.url).port;
  const launcher = createSandboxLauncher({
    service,
    snapshotId: "snap_local_mode",
    imageDigest: imageId,
    imageReference: IMAGE ?? "",
    logger,
    handoverSeconds: 5,
  });
  const core = createDispatcherCore({
    settings: settingsFor(`http://${APP_HOST}:${port}`, {
      engines: ["pr-agent"],
      jobTimeoutSeconds: 120,
    }),
    launcher,
    logger,
  });
  return { core, launcher, logger };
}

async function runJob(
  core: ReturnType<typeof build>["core"],
  launcher: ReturnType<typeof build>["launcher"],
): Promise<string> {
  const jobId = app.enqueue({ reviewKind: "diff" });
  const handled = await core.handle({ jobId, reviewKind: "diff" });
  expect(handled.outcome).toBe("started");
  if (handled.outcome === "started") await handled.background;
  await waitFor(
    () => app.results(jobId).length > 0,
    "the Worker's result",
    WORKER_RESULT_TIMEOUT_MS,
  );
  await launcher.idle();
  return jobId;
}

describe("the Sandbox-Launcher in local mode with a real Docker daemon", () => {
  // #329-T09
  it("runs the Worker container with the rendered flags and the Worker delivers a result to the fake App", async () => {
    const { bin, log } = await loggingDocker();
    const { core, launcher, logger } = build(bin);

    const jobId = await runJob(core, launcher);

    const used = await readFile(log, "utf8");
    for (const flag of [
      "--cap-drop ALL",
      "--security-opt no-new-privileges:true",
      "--read-only",
      "--sysctl net.ipv6.conf.all.disable_ipv6=1",
      "--memory 1536m",
      "--pids-limit 512",
    ])
      expect(used).toContain(flag);
    expect(used).not.toContain("--privileged");
    expect(used).not.toContain("--volume");
    expect(app.results(jobId).length).toBeGreaterThan(0);
    expect(logger.text()).not.toContain("crj_");
  });

  // #329-T10
  it("leaves nothing of job A for job B: no container, no VM directory", async () => {
    const { bin } = await loggingDocker();
    const { core, launcher } = build(bin);

    const jobA = await runJob(core, launcher);
    const directoryA = [...(service?.directories.values() ?? [])][0] ?? "";
    expect(
      docker("ps", "--all", "--quiet", "--filter", `name=${jobA}`).trim(),
    ).toBe("");
    expect(existsSync(directoryA)).toBe(false);

    const jobB = await runJob(core, launcher);
    expect(jobB).not.toBe(jobA);
    expect(
      docker(
        "ps",
        "--all",
        "--quiet",
        "--filter",
        "name=code-reviewer-worker-",
      ).trim(),
    ).toBe("");
    expect(service?.running()).toStrictEqual([]);
  });
});
