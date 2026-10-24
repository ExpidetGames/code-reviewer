// SPDX-License-Identifier: LicenseRef-Proprietary

// The Sandbox-Launcher (#316, #329): starts the Worker of one job as our hardened container inside a fresh
// Sandbox VM. Vercel's firewall is not part of the security boundary; everything security-relevant comes from
// the container, which is the one spec of container-spec.ts rendered by `ContainerLauncher`.
//
// Per job, in this order (the core has claimed the job and holds the credential):
//   1. create a VM from the golden snapshot: `persistent: false`, region fra1, no failover region, a VM size per
//      Worker kind, a timeout of the job's plus a margin as the backstop, a name nobody had before
//   2. vm-prepare.sh as root (cgroup fix, dockerd), then the image in the VM must be the configured id
//   3. `docker run --interactive` with the rendered flags; the start document goes through stdin only
//   4. resolve once the Worker has taken over (sandbox-host.ts); the core heartbeats until then
// After the hand-over the Launcher holds nothing (#487): no wait for the container, no supervision in `waitUntil`, no
// stop. The Worker owns the lease; the App tells the Dispatcher when the job's claim ends (`POST /stop`), and the
// reaper and the VM timeout are the safety nets.
// Every failure before the hand-over stops the VM by name and ends in a `LaunchError` with a stable code. A VM is
// never reused. The port to the platform is sandbox-service.ts; `vercel-sandbox.ts` is the one file that knows
// the SDK.
import {
  LaunchError,
  type Clock,
  type Engine,
  type LaunchConfig,
  type LaunchSpec,
  type Launcher,
  type Logger,
  type ReviewKind,
} from "../core/types.ts";
import { systemClock } from "../core/clock.ts";
import type { WorkerContainerOverrides } from "../contracts/worker-container.ts";
import {
  ContainerLauncher,
  ContainerSpecError,
  applyOverrides,
} from "./container.ts";
import {
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";
import { SandboxDockerHost } from "./sandbox-host.ts";
import {
  SandboxServiceError,
  type SandboxFailureKind,
  type SandboxService,
  type SandboxVm,
} from "./sandbox-service.ts";

/** Snapshots are region-bound and there is no failover region: fixed, not an option. */
export const SANDBOX_REGION = "fra1";
/**
 * How much longer than the job a VM may live if nobody stops it. The platform counts from the creation of the VM,
 * the Worker's own job timer from the start of the container, so the margin has to cover create, `vm-prepare.sh`, the
 * image check and the hand-over besides the Worker's delivery of a `timeout` result.
 */
export const VM_TIMEOUT_MARGIN_SECONDS = 300;
/** The longest the steps before `docker run` may take besides the hand-over: create 60, prepare 60, image check 30. */
export const LAUNCH_STEPS_SECONDS = 150;
const MIN_VM_TIMEOUT_MARGIN_SECONDS = 180;

/** The smallest margin that still covers the launch phase with this hand-over time. */
export function minimumVmTimeoutMargin(handoverSeconds: number): number {
  return Math.max(
    MIN_VM_TIMEOUT_MARGIN_SECONDS,
    handoverSeconds + LAUNCH_STEPS_SECONDS,
  );
}
/** How long the container must run for the Worker to count as having taken over (sandbox-host.ts). */
export const SANDBOX_HANDOVER_SECONDS = 20;
/** The tag the golden snapshot pipeline (#330) gives the Worker image in the snapshot. */
export const SANDBOX_IMAGE_REFERENCE = "code-reviewer-worker:golden";

/** The VM sizes the platform has: 1 or an even number up to 8 vCPUs, 2 GB of memory per vCPU (spike #317). */
export const SANDBOX_VCPUS = [1, 2, 4, 6, 8] as const;
const MEMORY_PER_VCPU_MB = 2048;
/** What the OS, dockerd and containerd need besides the container (the spike measured about 140 MB). */
const VM_HEADROOM_MB = 256;

/**
 * The size of the VM and the memory of the container per Worker kind when the operator configures nothing:
 * the smallest VM and 1.5 GB for the container. Configuration (`DISPATCHER_WORKER_CONFIG`) wins value by value.
 */
export const SANDBOX_KIND_DEFAULTS: Readonly<
  Record<
    ReviewKind,
    { vcpus: number; memory: { limit: string; reservation: string } }
  >
> = {
  diff: { vcpus: 1, memory: { limit: "1536m", reservation: "1280m" } },
  dynamic: { vcpus: 1, memory: { limit: "1536m", reservation: "1280m" } },
};

/** What every container is given, the same as the self-hosted compose service (names of the spec's allow-list). */
export const CONTAINER_ENVIRONMENT = {
  HOME: "/home/runner",
  RUNNER_DIFF_JOB_USER: "10001:10001",
} as const;

export type SandboxLauncherOptions = {
  service: SandboxService;
  /** The golden snapshot every VM starts from (#330). */
  snapshotId: string;
  /** The id of the Worker image in that snapshot; the image in the VM must be this one. */
  imageDigest: string;
  logger: Logger;
  clock?: Clock;
  imageReference?: string;
  handoverSeconds?: number;
  /** Seconds added to the job's timeout for the VM's own; at least `minimumVmTimeoutMargin(handoverSeconds)`. */
  vmTimeoutMarginSeconds?: number;
  /**
   * The engines this Launcher can run: both by default (#479). Which of them a deployment serves is its
   * `DISPATCHER_ENGINES`, which the core applies; the proof that the Dynamic-Worker's container is hardened is the
   * deploy canary (`POST /probe`), not a check per instance or per job.
   */
  capabilities?: (signal: AbortSignal) => Promise<readonly Engine[]>;
  /** The unique part of a VM name; random unless a test brings its own. */
  newSuffix?: () => string;
  /** The clock of the start the App is told about (#493); the system clock unless a test brings its own. */
  now?: () => Date;
  /**
   * The operator's Dynamic configuration, given to the container of a Dynamic job only (#331):
   * `RUNNER_DYNAMIC_CAPABILITIES` and `RUNNER_DYNAMIC_MAX_COST_USD`, as the self-hosted `runner-dynamic` service has
   * them. Non-secret; names of the container spec's allow-list.
   */
  dynamicEnvironment?: Readonly<Record<string, string>>;
};

export type Plan = {
  vcpus: number;
  overrides: WorkerContainerOverrides;
};

function configInvalid(): LaunchError {
  return new LaunchError("sandbox_config_invalid");
}

function megabytes(size: string): number {
  const amount = Number(size.slice(0, -1));
  return size.endsWith("g") ? amount * 1024 : amount;
}

/** The VM size and the container memory of a launch: the kind's defaults, then the configuration over them. */
function planOf(spec: LaunchSpec): Plan {
  const defaults = SANDBOX_KIND_DEFAULTS[spec.kind];
  const config: LaunchConfig = spec.config;

  const options = config.launcher ?? {};
  for (const key of Object.keys(options))
    if (key !== "vcpus") throw configInvalid();
  const vcpus = options.vcpus ?? defaults.vcpus;
  if (
    typeof vcpus !== "number" ||
    !(SANDBOX_VCPUS as readonly number[]).includes(vcpus)
  )
    throw configInvalid();

  const overrides: WorkerContainerOverrides = {
    memory: { ...defaults.memory, ...config.container?.memory },
  };
  try {
    const rendered = applyOverrides(WORKER_CONTAINER_SPEC, overrides);
    // A container that cannot fit in the VM beside the OS would be killed by the VM's own memory limit.
    if (
      megabytes(rendered.memory.limit) >
      vcpus * MEMORY_PER_VCPU_MB - VM_HEADROOM_MB
    )
      throw configInvalid();
  } catch (error) {
    if (error instanceof ContainerSpecError) throw configInvalid();
    throw error;
  }
  return { vcpus, overrides };
}

/**
 * Throws a `LaunchError` (`sandbox_config_invalid`) when the configuration of a Worker kind cannot be run: a VM
 * size the platform does not have, an option this Launcher does not know, a memory limit the spec refuses or one
 * that leaves the VM no room. Run at start so that a wrong value fails the deployment, not the first job.
 */
export function validateKindConfig(
  kind: ReviewKind,
  config: LaunchConfig,
): void {
  planForKind(kind, config);
}

/** The VM size and container memory a Worker kind gets (what a launch of that kind uses; the canary of #331 too). */
export function planForKind(kind: ReviewKind, config: LaunchConfig): Plan {
  return planOf({
    appUrl: "https://app.invalid",
    jobId: "validation",
    credential: "validation",
    kind,
    timeoutSeconds: 60,
    config,
  });
}

function slug(value: string, length: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, length);
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** The launch error for a failed platform call, and whether the VM may exist anyway (the call may have got through). */
export const CREATE_FAILURES: Readonly<
  Record<
    SandboxFailureKind,
    { code: string; retryable: boolean; mayExist: boolean }
  >
> = {
  rate_limited: {
    code: "sandbox_rate_limited",
    retryable: true,
    mayExist: false,
  },
  quota_exceeded: {
    code: "sandbox_quota_exceeded",
    retryable: true,
    mayExist: false,
  },
  network: { code: "sandbox_network", retryable: true, mayExist: true },
  unavailable: { code: "sandbox_unavailable", retryable: true, mayExist: true },
  not_ready: { code: "image_not_ready", retryable: true, mayExist: false },
  snapshot_missing: {
    code: "sandbox_snapshot_missing",
    retryable: false,
    mayExist: false,
  },
  region_mismatch: {
    code: "sandbox_region_mismatch",
    retryable: false,
    mayExist: false,
  },
  rejected: { code: "sandbox_rejected", retryable: false, mayExist: false },
  // An expired or wrong token (or OIDC token): the first thing an operator meets, and no retry fixes it.
  auth_failed: {
    code: "sandbox_auth_failed",
    retryable: false,
    mayExist: false,
  },
};

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function createSandboxLauncher(
  options: SandboxLauncherOptions,
): Launcher {
  const { service, logger } = options;
  const clock = options.clock ?? systemClock;
  const handoverSeconds = options.handoverSeconds ?? SANDBOX_HANDOVER_SECONDS;
  const vmTimeoutMarginSeconds =
    options.vmTimeoutMarginSeconds ?? VM_TIMEOUT_MARGIN_SECONDS;
  if (vmTimeoutMarginSeconds < minimumVmTimeoutMargin(handoverSeconds))
    throw new Error(
      `vmTimeoutMarginSeconds must be at least ${minimumVmTimeoutMargin(handoverSeconds)}`,
    );

  async function stopQuietly(name: string, jobId: string): Promise<void> {
    try {
      await service.stop(name);
    } catch {
      // Only that it failed: the platform's text is not ours to log. The VM timeout ends the VM.
      logger.warn("sandbox_stop_failed", { jobId, sandbox: name });
    }
  }

  async function createVm(
    plan: Plan,
    spec: LaunchSpec,
    name: string,
    signal: AbortSignal,
  ): Promise<SandboxVm> {
    try {
      return await service.create(
        {
          name,
          snapshotId: options.snapshotId,
          region: SANDBOX_REGION,
          vcpus: plan.vcpus,
          timeoutMs: (spec.timeoutSeconds + vmTimeoutMarginSeconds) * 1000,
          tags: { app: "code-reviewer", kind: spec.kind, job: spec.jobId },
          persistent: false,
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted || isAbort(error)) {
        // The call may have got through before the abort: stop by name, which is harmless for a VM that is not there.
        await stopQuietly(name, spec.jobId);
        throw new LaunchError("launch_aborted");
      }
      const known =
        error instanceof SandboxServiceError
          ? CREATE_FAILURES[error.kind]
          : undefined;
      if (known === undefined || known.mayExist)
        await stopQuietly(name, spec.jobId);
      throw new LaunchError(known?.code ?? "sandbox_create_failed", {
        retryable: known?.retryable ?? false,
      });
    }
  }

  /** Every failure before the hand-over: stop the VM by name and end in a `LaunchError` with a stable code. */
  async function failLaunch(
    name: string,
    spec: LaunchSpec,
    signal: AbortSignal,
    error: unknown,
    fallbackCode: { code: string; retryable: boolean },
  ): Promise<LaunchError> {
    await stopQuietly(name, spec.jobId);
    if (error instanceof LaunchError) return error;
    if (signal.aborted || isAbort(error))
      return new LaunchError("launch_aborted");
    if (error instanceof ContainerSpecError) return configInvalid();
    if (error instanceof SandboxServiceError) {
      const known = CREATE_FAILURES[error.kind];
      return new LaunchError(known.code, { retryable: known.retryable });
    }
    return new LaunchError(fallbackCode.code, {
      retryable: fallbackCode.retryable,
    });
  }

  return {
    capabilities(signal) {
      return (
        options.capabilities?.(signal) ??
        Promise.resolve(["pr-agent", "opencode"])
      );
    },

    async launch(spec, signal) {
      const plan = planOf(spec);
      const requested = `cr-${slug(spec.kind, 8)}-${slug(spec.jobId, 36)}-${(options.newSuffix ?? randomSuffix)()}`;

      const vm = await createVm(plan, spec, requested, signal);
      const createdAt = (options.now ?? (() => new Date()))();
      // The platform's own name is the one that stops the VM; a normalised name must not make a stop a no-op.
      const name = vm.name;
      if (name !== requested)
        logger.warn("sandbox_name_mismatch", { jobId: spec.jobId });
      // #493: the core tells the App that the VM exists (its billable minutes start here). It returns at once and the
      // launch does not depend on it: a callback that throws is ignored.
      try {
        spec.onVmCreated?.({
          name,
          startedAt: createdAt,
          timeoutSeconds: spec.timeoutSeconds + vmTimeoutMarginSeconds,
        });
      } catch {
        // Only that it failed.
      }
      const host = new SandboxDockerHost({
        vm,
        clock,
        logger,
        logFields: { jobId: spec.jobId },
        imageReference: options.imageReference ?? SANDBOX_IMAGE_REFERENCE,
        imageDigest: options.imageDigest,
        handoverSeconds,
      });
      try {
        await host.prepare(signal);
      } catch (error) {
        throw await failLaunch(name, spec, signal, error, {
          code: "vm_prepare_failed",
          retryable: true,
        });
      }
      try {
        const containers = new ContainerLauncher({
          host,
          spec: WORKER_CONTAINER_SPEC,
          // By id: exactly the image that was just verified, and a reference that cannot be pulled.
          image: options.imageDigest,
          environment:
            spec.kind === "dynamic"
              ? { ...CONTAINER_ENVIRONMENT, ...options.dynamicEnvironment }
              : CONTAINER_ENVIRONMENT,
          additions: SANDBOX_LAUNCHER_ADDITIONS,
        });
        const running = containers.launch(
          { ...spec, config: { ...spec.config, container: plan.overrides } },
          signal,
        );
        running.catch((error: unknown) => host.fail(error));
        await host.handover;
      } catch (error) {
        throw await failLaunch(name, spec, signal, error, {
          code: "worker_start_failed",
          retryable: true,
        });
      }
    },
  };
}
