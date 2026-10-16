// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { createDispatcherCore } from "../core/dispatcher.ts";
import { LaunchError, type LaunchSpec } from "../core/types.ts";
import {
  DISPATCHER_TOKEN,
  recordingLogger,
  settingsFor,
  startApp,
  waitFor,
  type RecordedLogger,
} from "../test-support/harness.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import { DEFAULT_CONFIG } from "../snapshot/config.ts";
import { PATHS } from "../snapshot/scripts.ts";
import { WORKER_CONTAINER_SPEC } from "./container-spec.ts";
import { VM_PREPARE_PATH } from "./sandbox-host.ts";
import {
  SANDBOX_HANDOVER_SECONDS,
  SANDBOX_IMAGE_REFERENCE,
  SANDBOX_REGION,
  minimumVmTimeoutMargin,
  VM_TIMEOUT_MARGIN_SECONDS,
  createSandboxLauncher,
  type SandboxLauncher,
  type SandboxLauncherOptions,
} from "./sandbox.ts";
import {
  SANDBOX_FAILURE_KINDS,
  SandboxServiceError,
  type SandboxFailureKind,
} from "./sandbox-service.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const OTHER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_ID = "snap_dummy_golden_0001";
const CREDENTIAL = "crj_dummy-credential-0123456789-abcdefghijklmnopq";
const JOB_ID = "00000000-0000-4000-8000-000000000001";

let service: FakeSandboxService;
let clock: ManualClock;
let logger: RecordedLogger;
let background: Promise<unknown>[];

beforeEach(() => {
  service = new FakeSandboxService();
  service.onExec("image-id", { stdout: `${IMAGE_ID}\n` });
  clock = new ManualClock();
  logger = recordingLogger();
  background = [];
});

function build(
  overrides: Partial<SandboxLauncherOptions> = {},
): SandboxLauncher {
  return createSandboxLauncher({
    service,
    snapshotId: SNAPSHOT_ID,
    imageDigest: IMAGE_ID,
    logger,
    clock,
    background: (work) => background.push(work),
    ...overrides,
  });
}

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    appUrl: "https://app.example.invalid",
    jobId: JOB_ID,
    credential: CREDENTIAL,
    kind: "diff",
    timeoutSeconds: 1200,
    config: {},
    ...overrides,
  };
}

/** Starts a launch, lets the clock run through the hand-over wait and returns how it ended. */
async function launch(
  launcher: SandboxLauncher,
  launchSpec: LaunchSpec = spec(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const ended = launcher.launch(launchSpec, signal).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  await settle();
  await clock.advance(SANDBOX_HANDOVER_SECONDS * 1000);
  return ended;
}

function failure(result: Awaited<ReturnType<typeof launch>>): LaunchError {
  if (result.ok) throw new Error("the launch was expected to fail");
  expect(result.error).toBeInstanceOf(LaunchError);
  return result.error as LaunchError;
}

const dockerRun = () => service.starts.find((s) => s.label === "docker-run");

function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag ? [args[index + 1] ?? ""] : [],
  );
}

describe("the Sandbox-Launcher", () => {
  // #329-T01
  it("creates a VM from the golden snapshot, prepares the host, runs the container and delivers the start document on stdin", async () => {
    const launcher = build();

    const result = await launch(launcher);

    expect(result).toStrictEqual({ ok: true });
    expect(service.creates).toHaveLength(1);
    const [created] = service.creates;
    expect(created?.snapshotId).toBe(SNAPSHOT_ID);
    const name = created?.name ?? "";
    expect(service.events).toStrictEqual([
      `create:${name}`,
      "exec:vm-prepare",
      "exec:image-id",
      "start:docker-run",
      `stdin:${name}`,
    ]);
    // The cgroup fix and dockerd run as root, from the golden snapshot's script.
    expect(service.execs[0]).toMatchObject({
      label: "vm-prepare",
      cmd: "/usr/local/sbin/vm-prepare.sh",
      args: [],
      sudo: true,
    });
    const run = dockerRun();
    expect(run).toMatchObject({ cmd: "docker", sudo: true });
    const args = run?.args ?? [];
    expect(args[0]).toBe("run");
    expect(args).toContain("--read-only");
    expect(valuesOf(args, "--cap-drop")).toStrictEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toStrictEqual([
      "no-new-privileges:true",
    ]);
    // The IPv6 switches of the Sandbox variant, for every kind (#345).
    expect(valuesOf(args, "--sysctl")).toStrictEqual([
      "net.ipv6.conf.all.disable_ipv6=1",
      "net.ipv6.conf.default.disable_ipv6=1",
    ]);
    // The image that was verified is the image that runs, by id.
    expect(args.slice(-2)).toStrictEqual([IMAGE_ID, "worker-once"]);
    expect(valuesOf(args, "--env")).toContain(
      "RUNNER_JOB_TIMEOUT_SECONDS=1200",
    );
    expect(JSON.parse(service.stdinOf(name))).toStrictEqual({
      appUrl: "https://app.example.invalid",
      jobId: JOB_ID,
      credential: CREDENTIAL,
    });
    expect(service.stdinClosed(name)).toBe(true);
  });

  // #331-T09
  it("gives a Dynamic job the operator's Dynamic configuration and a Diff job none of it", async () => {
    const dynamicEnvironment = {
      RUNNER_DYNAMIC_CAPABILITIES: '{"tool_choice_required":true}',
      RUNNER_DYNAMIC_MAX_COST_USD: "2.5",
    };
    const launcher = build({ dynamicEnvironment });

    await launch(launcher, spec({ kind: "dynamic" }));
    await launch(
      launcher,
      spec({ kind: "diff", jobId: "00000000-0000-4000-8000-000000000002" }),
    );

    const [dynamic, diff] = service.starts.map((call) =>
      valuesOf(call.args, "--env"),
    );
    expect(dynamic).toContain("RUNNER_DYNAMIC_MAX_COST_USD=2.5");
    expect(dynamic).toContain(
      'RUNNER_DYNAMIC_CAPABILITIES={"tool_choice_required":true}',
    );
    expect(dynamic).toContain("HOME=/home/runner");
    expect(diff?.some((entry) => entry.startsWith("RUNNER_DYNAMIC"))).toBe(
      false,
    );
  });

  // #331-T09
  it("passes nothing of the kind when the operator configured nothing", async () => {
    await launch(build(), spec({ kind: "dynamic" }));

    const environment = valuesOf(dockerRun()?.args ?? [], "--env");
    expect(
      environment.some((entry) => entry.startsWith("RUNNER_DYNAMIC")),
    ).toBe(false);
  });

  // #329-T02
  it("puts the credential on the stdin pipe and nowhere else: no argument, no environment, no file, no log line", async () => {
    const launcher = build();

    await launch(launcher);
    service.exitProcess(service.creates[0]?.name ?? "", 0);
    await launcher.idle();

    const name = service.creates[0]?.name ?? "";
    expect(service.stdinOf(name)).toContain(CREDENTIAL);
    expect(service.requestText()).not.toContain(CREDENTIAL);
    expect(logger.text()).not.toContain(CREDENTIAL);
    // The port has no way to set an environment or write a file on the VM; the requests prove it.
    for (const call of [...service.execs, ...service.starts])
      expect(Object.keys(call).sort()).not.toContain("env");
    expect(service.requestText()).not.toContain("writeFile");
  });

  // #329-T03
  it("creates the VM in fra1 without persistence, without a failover region and under a name no earlier VM had", async () => {
    const launcher = build();

    await launch(launcher);
    await launch(launcher);

    const [first, second] = service.creates;
    expect(first).toMatchObject({
      region: "fra1",
      persistent: false,
      snapshotId: SNAPSHOT_ID,
    });
    expect(SANDBOX_REGION).toBe("fra1");
    expect(Object.keys(first ?? {}).sort()).toStrictEqual([
      "name",
      "persistent",
      "region",
      "snapshotId",
      "tags",
      "timeoutMs",
      "vcpus",
    ]);
    // The same job twice (a second attempt) gets a new name, and the name carries the job.
    expect(first?.name).toMatch(/^cr-diff-[a-z0-9-]+-[a-z0-9]{8}$/);
    expect(first?.name).toContain(JOB_ID);
    expect(first?.name.length).toBeLessThanOrEqual(63);
    expect(second?.name).not.toBe(first?.name);
    expect(first?.tags).toStrictEqual({
      app: "code-reviewer",
      kind: "diff",
      job: JOB_ID,
    });
  });

  // #329-T04
  it.each<[SandboxFailureKind, string, boolean]>([
    ["rate_limited", "sandbox_rate_limited", true],
    ["quota_exceeded", "sandbox_quota_exceeded", true],
    ["network", "sandbox_network", true],
    ["unavailable", "sandbox_unavailable", true],
    ["not_ready", "image_not_ready", true],
    ["snapshot_missing", "sandbox_snapshot_missing", false],
    ["region_mismatch", "sandbox_region_mismatch", false],
    ["rejected", "sandbox_rejected", false],
    ["auth_failed", "sandbox_auth_failed", false],
  ])(
    "turns a failed create (%s) into LaunchError %s, retryable %s",
    async (kind, code, retryable) => {
      service.failNextCreate(new SandboxServiceError(kind));

      const error = failure(await launch(build()));

      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toBe(code);
      expect(service.starts).toHaveLength(0);
    },
  );

  // #329-T04
  it("covers every failure kind of the port", () => {
    expect(SANDBOX_FAILURE_KINDS).toHaveLength(9);
  });

  // #329-T04
  it("turns an error it does not know into a non-retryable launch error without its text", async () => {
    service.failNextCreate(new Error("secret platform text 12345"));

    const error = failure(await launch(build()));

    expect(error.code).toBe("sandbox_create_failed");
    expect(error.retryable).toBe(false);
    expect(logger.text()).not.toContain("12345");
  });

  // #329-T04
  it("does not stop by name after a refusal, but does after a failure that may have created the VM", async () => {
    service.failNextCreate(new SandboxServiceError("rate_limited"));
    await launch(build());
    expect(service.stops).toStrictEqual([]);

    service.failNextCreate(new SandboxServiceError("network"));
    await launch(build());
    expect(service.stops).toHaveLength(1);
    expect(service.stops[0]).toBe(service.creates[1]?.name);
  });

  // #329-T05
  it("stops the VM and fails the launch when the daemon does not become ready", async () => {
    service.onExec("vm-prepare", {
      exitCode: 1,
      stderr: "dockerd did not become ready",
    });

    const error = failure(await launch(build()));

    expect(error.code).toBe("docker_not_ready");
    expect(error.retryable).toBe(true);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(service.starts).toHaveLength(0);
    expect(service.running()).toStrictEqual([]);
  });

  // #329-T06
  it("refuses an image whose id is not the configured digest and stops the VM", async () => {
    service.onExec("image-id", { stdout: `${OTHER_IMAGE_ID}\n` });

    const error = failure(await launch(build()));

    expect(error.code).toBe("image_mismatch");
    expect(error.retryable).toBe(false);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(service.starts).toHaveLength(0);
    expect(service.stdinOf(service.creates[0]?.name ?? "")).toBe("");
    // The ids are not secrets, but the log holds codes only.
    expect(logger.text()).not.toContain(OTHER_IMAGE_ID);
  });

  // #329-T06
  it("fails with image_missing when the VM has no such image", async () => {
    service.onExec("image-id", { exitCode: 1, stderr: "No such image" });

    const error = failure(await launch(build()));

    expect(error.code).toBe("image_missing");
    expect(service.stops).toHaveLength(1);
    expect(service.starts).toHaveLength(0);
  });

  // #329-T07
  it("stops the VM when the container ends and sets the VM timeout as the backstop", async () => {
    const launcher = build();
    await launch(launcher);
    const name = service.creates[0]?.name ?? "";

    expect(service.creates[0]?.timeoutMs).toBe(
      (1200 + VM_TIMEOUT_MARGIN_SECONDS) * 1000,
    );
    expect(VM_TIMEOUT_MARGIN_SECONDS).toBe(300);
    expect(service.stops).toStrictEqual([]);
    expect(background).toHaveLength(1);

    service.exitProcess(name, 0);
    await launcher.idle();

    expect(service.stops).toStrictEqual([name]);
    expect(service.running()).toStrictEqual([]);
  });

  // #329-T07
  it("also tears the VM down when the container ends with an error, and reports a failing stop by code only", async () => {
    const launcher = build();
    await launch(launcher);
    const name = service.creates[0]?.name ?? "";
    service.failStops(new Error("platform text with 98765"));

    service.exitProcess(name, 1);
    await launcher.idle();

    expect(service.stops).toStrictEqual([name]);
    expect(logger.text()).toContain("sandbox_stop_failed");
    expect(logger.text()).not.toContain("98765");
  });

  // #329-T07
  it("resolves when the container has run through the hand-over wait, not when it ends", async () => {
    const launcher = build();

    const result = await launch(launcher);

    expect(result).toStrictEqual({ ok: true });
    expect(service.running()).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T07
  it("treats a container that ended with 0 before the wait is over as handed over", async () => {
    const launcher = build();
    const ended = launcher.launch(spec(), new AbortController().signal);
    await settle();
    service.exitProcess(service.creates[0]?.name ?? "", 0);

    await expect(ended).resolves.toBeUndefined();
    await launcher.idle();
    expect(service.stops).toHaveLength(1);
  });

  // #329-T07
  it("fails the launch when the container ends with an error before the hand-over", async () => {
    const launcher = build();
    const ended = launcher.launch(spec(), new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();
    service.exitProcess(service.creates[0]?.name ?? "", 2);

    const error = (await ended) as LaunchError;

    expect(error).toBeInstanceOf(LaunchError);
    expect(error.code).toBe("worker_exited_early");
    expect(error.retryable).toBe(true);
    await launcher.idle();
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T08
  it("kills the container and stops the VM by name when the signal aborts during the hand-over", async () => {
    const launcher = build();
    const stop = new AbortController();
    const ended = launcher.launch(spec(), stop.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();

    stop.abort();
    const error = (await ended) as LaunchError;

    expect(error.code).toBe("launch_aborted");
    const name = service.creates[0]?.name ?? "";
    expect(service.stops).toStrictEqual([name]);
    expect(service.execs.map((e) => e.label)).toContain("docker-kill");
    const kill = service.execs.find((e) => e.label === "docker-kill");
    expect(kill?.args).toStrictEqual([
      "kill",
      `code-reviewer-worker-${JOB_ID}`,
    ]);
    expect(service.running()).toStrictEqual([]);
  });

  // #329-T08
  it("stops the VM by name when the signal aborts while it is being created", async () => {
    const hold = service.holdNextCreate();
    const launcher = build();
    const stop = new AbortController();
    const ended = launcher.launch(spec(), stop.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();

    stop.abort();
    const error = (await ended) as LaunchError;
    hold.release();

    expect(error).toBeInstanceOf(LaunchError);
    expect(error.code).toBe("launch_aborted");
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T08
  it("does not tie the Worker's life to the signal after the hand-over", async () => {
    const launcher = build();
    const stop = new AbortController();
    await launch(launcher, spec(), stop.signal);

    stop.abort();
    await settle();

    expect(service.stops).toStrictEqual([]);
    expect(service.running()).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T11
  it("gives each Worker kind its own VM size and container memory limit from configuration", async () => {
    const launcher = build();

    await launch(
      launcher,
      spec({
        kind: "dynamic",
        config: {
          launcher: { vcpus: 2 },
          container: { memory: { limit: "3g", reservation: "2g" } },
        },
      }),
    );
    await launch(launcher, spec({ kind: "diff", config: {} }));

    const [dynamic, diff] = service.starts;
    const [dynamicVm, diffVm] = service.creates;
    expect(dynamicVm?.vcpus).toBe(2);
    expect(valuesOf(dynamic?.args ?? [], "--memory")).toStrictEqual(["3g"]);
    expect(valuesOf(dynamic?.args ?? [], "--memory-swap")).toStrictEqual([
      "3g",
    ]);
    expect(valuesOf(dynamic?.args ?? [], "--memory-reservation")).toStrictEqual(
      ["2g"],
    );
    expect(dynamicVm?.tags.kind).toBe("dynamic");
    // The default of a kind with no configuration: the smallest VM, 1.5 GB for the container.
    expect(diffVm?.vcpus).toBe(1);
    expect(valuesOf(diff?.args ?? [], "--memory")).toStrictEqual(["1536m"]);
    expect(valuesOf(diff?.args ?? [], "--memory-swap")).toStrictEqual([
      "1536m",
    ]);
  });

  // #329-T11
  it("uses a changed value without a code change", async () => {
    const launcher = build();

    await launch(launcher, spec({ config: { launcher: { vcpus: 4 } } }));
    await launch(
      launcher,
      spec({
        config: {
          launcher: { vcpus: 4 },
          container: { memory: { limit: "6g" } },
        },
      }),
    );

    expect(service.creates.map((created) => created.vcpus)).toStrictEqual([
      4, 4,
    ]);
    expect(valuesOf(service.starts[0]?.args ?? [], "--memory")).toStrictEqual([
      "1536m",
    ]);
    expect(valuesOf(service.starts[1]?.args ?? [], "--memory")).toStrictEqual([
      "6g",
    ]);
  });

  // #329-T11
  it("refuses a container limit that leaves the VM no room for the OS and dockerd", async () => {
    const error = failure(
      await launch(
        build(),
        spec({ config: { container: { memory: { limit: "2g" } } } }),
      ),
    );

    expect(error.code).toBe("sandbox_config_invalid");
    expect(service.creates).toStrictEqual([]);
  });

  // #329-T11
  it.each<[string, Record<string, string | number | boolean>]>([
    ["a VM size the platform does not have", { vcpus: 3 }],
    ["a VM size that is not a number", { vcpus: "two" }],
    ["too many vCPUs", { vcpus: 16 }],
    ["an option it does not know", { vcpus: 1, region: "iad1" }],
  ])("refuses %s before it creates anything", async (_what, options) => {
    const error = failure(
      await launch(build(), spec({ config: { launcher: options } })),
    );

    expect(error.code).toBe("sandbox_config_invalid");
    expect(error.retryable).toBe(false);
    expect(service.creates).toStrictEqual([]);
  });

  // #329-T11
  it("refuses a memory override that weakens the container before it creates anything", async () => {
    const error = failure(
      await launch(
        build(),
        spec({
          config: { container: { memory: { limit: "1g", reservation: "2g" } } },
        }),
      ),
    );

    expect(error.code).toBe("sandbox_config_invalid");
    expect(service.creates).toStrictEqual([]);
  });

  // #329 (additional): capabilities
  it("advertises PR-Agent only until a probe vouches for the Dynamic-Worker (#331)", async () => {
    const signal = new AbortController().signal;

    expect(await build().capabilities(signal)).toStrictEqual(["pr-agent"]);
    expect(
      await build({
        capabilities: () => Promise.resolve(["pr-agent", "opencode"]),
      }).capabilities(signal),
    ).toStrictEqual(["pr-agent", "opencode"]);
  });

  // #329 (additional): the Launcher and the golden snapshot pipeline (#330) name the same things
  it("agrees with the golden snapshot pipeline on the script, the image tag and the region", () => {
    expect(VM_PREPARE_PATH).toBe(PATHS.vmPrepareInstalled);
    expect(SANDBOX_IMAGE_REFERENCE).toBe(DEFAULT_CONFIG.imageTag);
    expect(SANDBOX_REGION).toBe(DEFAULT_CONFIG.region);
  });

  // #329 (additional): the container is the shared hardened spec
  it("renders the container from the shared hardened spec", async () => {
    await launch(build());

    const args = dockerRun()?.args ?? [];
    expect(valuesOf(args, "--user")).toStrictEqual([
      WORKER_CONTAINER_SPEC.user,
    ]);
    expect(valuesOf(args, "--pids-limit")).toStrictEqual(["512"]);
    for (const forbidden of ["--privileged", "--volume", "-v", "--device"])
      expect(args).not.toContain(forbidden);
  });
});

describe("findings of the review of #354", () => {
  // #329-R01
  it("retries a wait that failed after the hand-over and stops the VM only when the exit is confirmed", async () => {
    const launcher = build();
    await launch(launcher);
    const name = service.creates[0]?.name ?? "";

    service.dropWaits(name, new Error("the log stream broke"));
    await settle();
    await clock.advance(60_000);

    expect(service.stops).toStrictEqual([]);
    expect(service.running()).toStrictEqual([name]);

    service.exitProcess(name, 0);
    await launcher.idle();

    expect(service.stops).toStrictEqual([name]);
    expect(logger.text()).not.toContain("log stream");
  });

  // #329-R01
  it("leaves a healthy VM to its timeout when the wait keeps failing, and logs a stable code", async () => {
    const launcher = build();
    await launch(launcher);
    const name = service.creates[0]?.name ?? "";

    service.failWaits(10, new Error("the log stream broke 4711"));
    service.dropWaits(name, new Error("the log stream broke 4711"));
    const idle = launcher.idle();
    await settle();
    await clock.advance(120_000);
    await idle;

    expect(service.stops).toStrictEqual([]);
    expect(service.running()).toStrictEqual([name]);
    expect(logger.text()).toContain("worker_wait_failed");
    expect(logger.text()).toContain('"attempts":3');
    expect(logger.text()).not.toContain("4711");
  });

  // #329-R02
  it("stops the VM by the name the platform returned, not the one it was asked for", async () => {
    service.renameCreatedVms((name) => `${name}-normalised`);
    const launcher = build();
    await launch(launcher);
    const requested = service.creates[0]?.name ?? "";
    const returned = `${requested}-normalised`;

    service.exitProcess(returned, 0);
    await launcher.idle();

    expect(service.stops).toStrictEqual([returned]);
    expect(service.running()).toStrictEqual([]);
    expect(logger.text()).toContain("sandbox_name_mismatch");
  });

  // #329-R02
  it("stops a failed launch by the returned name too", async () => {
    service.renameCreatedVms((name) => `${name}-normalised`);
    service.onExec("image-id", { stdout: `${OTHER_IMAGE_ID}\n` });

    await launch(build());

    expect(service.stops).toStrictEqual([
      `${service.creates[0]?.name}-normalised`,
    ]);
    expect(service.running()).toStrictEqual([]);
  });

  // #329-R03
  it("gives the VM a timeout that covers the launch phase: the job plus 300 seconds by default", async () => {
    await launch(build());

    expect(service.creates[0]?.timeoutMs).toBe((1200 + 300) * 1000);
  });

  // #329-R03
  it("takes the margin from configuration", async () => {
    await launch(build({ vmTimeoutMarginSeconds: 600 }));

    expect(service.creates[0]?.timeoutMs).toBe((1200 + 600) * 1000);
  });

  // #329-R03
  it("refuses a margin below the floor that covers create, prepare, the image check and the hand-over", () => {
    expect(minimumVmTimeoutMargin(20)).toBe(180);
    expect(minimumVmTimeoutMargin(60)).toBe(210);

    expect(() => build({ vmTimeoutMarginSeconds: 179 })).toThrowError(
      /vmTimeoutMarginSeconds/,
    );
    expect(() =>
      build({ handoverSeconds: 60, vmTimeoutMarginSeconds: 209 }),
    ).toThrowError(/vmTimeoutMarginSeconds/);
    expect(() => build({ vmTimeoutMarginSeconds: 180 })).not.toThrow();
  });

  // #329-R04
  it("passes the mapped code through when a call of the host preparation fails at the platform", async () => {
    service.onExec("vm-prepare", () => {
      throw new SandboxServiceError("rate_limited");
    });

    const error = failure(await launch(build()));

    expect(error.code).toBe("sandbox_rate_limited");
    expect(error.retryable).toBe(true);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-R04
  it("gives an unknown failure of the host preparation its own code", async () => {
    service.onExec("vm-prepare", () => {
      throw new Error("something odd 31337");
    });

    const error = failure(await launch(build()));

    expect(error.code).toBe("vm_prepare_failed");
    expect(error.retryable).toBe(true);
    expect(logger.text()).not.toContain("31337");
  });

  // #329-R04
  it.each<[number, boolean]>([
    // The Worker ran and said the job failed: it delivered its own result, and a second VM would do the same.
    [1, false],
    // A setup error of the Worker (2), docker's own refusals (125 to 127) and a kill (137): something about this VM
    // or its start, which a fresh VM can get right.
    [2, true],
    [125, true],
    [126, true],
    [127, true],
    [137, true],
  ])(
    "decides whether an exit with %s before the hand-over is retryable",
    async (exitCode, retryable) => {
      const launcher = build();
      const ended = launcher.launch(spec(), new AbortController().signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      await settle();

      service.exitProcess(service.creates[0]?.name ?? "", exitCode);
      const error = (await ended) as LaunchError;

      expect(error.code).toBe("worker_exited_early");
      expect(error.retryable).toBe(retryable);
    },
  );
});

/** What the Launcher tells the core when the Worker's container ends after the hand-over (#375). */
describe("the Sandbox-Launcher and the end of a Worker that took over", () => {
  /** A launched job whose spec brings a recording `onWorkerExit`. */
  async function handedOver(report: (exitCode: number) => Promise<void>) {
    const launcher = build();
    const calls: number[] = [];
    const result = await launch(
      launcher,
      spec({
        onWorkerExit: (exitCode) => {
          calls.push(exitCode);
          return report(exitCode);
        },
      }),
    );
    expect(result).toStrictEqual({ ok: true });
    return { launcher, calls, name: service.creates[0]?.name ?? "" };
  }

  // #375-T01
  it("tells the core the exit code when the container ends with an error after the hand-over, and stops the VM", async () => {
    const { launcher, calls, name } = await handedOver(() => Promise.resolve());

    service.exitProcess(name, 2);
    await launcher.idle();

    expect(calls).toStrictEqual([2]);
    expect(service.stops).toStrictEqual([name]);
    expect(logger.text()).toContain('"exitCode":2');
    expect(logger.text()).not.toContain(CREDENTIAL);
  });

  // #375-T04
  it("tells the core nothing when the container ends with 0, and still stops the VM", async () => {
    const { launcher, calls, name } = await handedOver(() => Promise.resolve());

    service.exitProcess(name, 0);
    await launcher.idle();

    expect(calls).toStrictEqual([]);
    expect(service.stops).toStrictEqual([name]);
  });

  // #375-T05
  it("tells the core nothing and leaves the VM alone when the wait for the container fails", async () => {
    const { launcher, calls, name } = await handedOver(() => Promise.resolve());

    service.failWaits(10, new Error("the log stream broke"));
    service.dropWaits(name, new Error("the log stream broke"));
    const idle = launcher.idle();
    await settle();
    await clock.advance(120_000);
    await idle;

    expect(calls).toStrictEqual([]);
    expect(service.stops).toStrictEqual([]);
    expect(service.running()).toStrictEqual([name]);
    expect(logger.text()).toContain("worker_wait_failed");
  });

  // #375-T05
  it("does not tell the core of a container that ended with an error before the hand-over: the launch fails instead", async () => {
    const launcher = build();
    const calls: number[] = [];
    const ended = launcher
      .launch(
        spec({
          onWorkerExit: (exitCode) => {
            calls.push(exitCode);
            return Promise.resolve();
          },
        }),
        new AbortController().signal,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await settle();
    service.exitProcess(service.creates[0]?.name ?? "", 2);

    expect(((await ended) as LaunchError).code).toBe("worker_exited_early");
    await launcher.idle();
    // The core releases that job with launch_failed once; a second release for the same end would count twice.
    expect(calls).toStrictEqual([]);
  });

  // #375-T07
  it("stops the VM even when the core's answer fails or never comes", async () => {
    const failing = await handedOver(() =>
      Promise.reject(new Error(`boom ${CREDENTIAL}`)),
    );
    service.exitProcess(failing.name, 137);
    await failing.launcher.idle();
    expect(service.stops).toStrictEqual([failing.name]);
    expect(logger.text()).toContain("worker_exit_report_failed");
    expect(logger.text()).not.toContain(CREDENTIAL);
  });

  // #375-T07
  it("does not hold the VM back while the core is still talking to the App", async () => {
    const { calls, name } = await handedOver(
      () => new Promise(() => undefined),
    );

    service.exitProcess(name, 2);
    await settle();

    expect(calls).toStrictEqual([2]);
    expect(service.stops).toStrictEqual([name]);
  });
});

describe("the Sandbox-Launcher in the Dispatcher core", () => {
  // #329-T12
  it("makes the core release the job with launch_failed and count the attempt when the platform refuses", async () => {
    const app = await startApp();
    try {
      const jobId = app.enqueue();
      service.failNextCreate(new SandboxServiceError("quota_exceeded"));
      const core = createDispatcherCore({
        settings: settingsFor(app.url, { engines: ["pr-agent"] }),
        launcher: build(),
        logger,
        clock,
      });

      const result = await core.handle({ jobId, reviewKind: "diff" });
      expect(result.outcome).toBe("started");
      if (result.outcome !== "started") return;
      let done = false;
      void result.background.then(() => {
        done = true;
      });
      for (let step = 0; step < 100 && !done; step += 1) {
        await clock.advance(10_000);
        await settle();
      }
      await result.background;

      await waitFor(
        () => app.requests().some((request) => request.route === "release"),
        "the release",
      );
      expect(
        app.requests().filter((request) => request.route === "release"),
      ).toStrictEqual([
        { method: "POST", route: "release", jobId, status: 200 },
      ]);
      expect(logger.text()).toContain("launch_failed");
      expect(logger.text()).toContain("sandbox_quota_exceeded");
      expect(logger.text()).toContain('"retryable":true');
      expect(logger.text()).not.toContain(DISPATCHER_TOKEN);
    } finally {
      await app.close();
    }
  });

  // #375-T01
  it("makes the core release the job with worker_exited at once when the Worker's container ends with 2 after the hand-over", async () => {
    const app = await startApp();
    try {
      const jobId = app.enqueue();
      const core = createDispatcherCore({
        settings: settingsFor(app.url, { engines: ["pr-agent"] }),
        launcher: build(),
        logger,
        clock,
      });
      const started = core.handle({ jobId, reviewKind: "diff" });
      // The claim goes over real HTTP: the container is started when the App has answered, not after a fixed wait.
      await waitFor(() => dockerRun() !== undefined, "the container to start");
      await settle();
      await clock.advance(SANDBOX_HANDOVER_SECONDS * 1000);
      const result = await started;
      expect(result.outcome).toBe("started");
      if (result.outcome !== "started") return;
      await result.background;
      // The Worker took over and the core is done with the launch: nothing released yet.
      expect(
        app.requests().filter((request) => request.route === "release"),
      ).toStrictEqual([]);

      service.exitProcess(service.creates[0]?.name ?? "", 2);
      // The App answered, and the core has logged what it did with the answer.
      await waitFor(
        () => logger.text().includes('"reason":"worker_exited"'),
        "the release",
      );

      expect(
        app.requests().filter((request) => request.route === "release"),
      ).toStrictEqual([
        { method: "POST", route: "release", jobId, status: 200 },
      ]);
      expect(logger.text()).toContain('"reason":"worker_exited"');
      expect(logger.text()).not.toContain(DISPATCHER_TOKEN);
      expect(logger.text()).not.toContain(CREDENTIAL);
      // The job is queued again for the next claim.
      expect((await core.handle({ jobId, reviewKind: "diff" })).outcome).toBe(
        "started",
      );
    } finally {
      await app.close();
    }
  });
});
