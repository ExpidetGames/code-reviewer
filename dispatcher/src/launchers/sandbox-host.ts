// SPDX-License-Identifier: Apache-2.0

// Where `docker run` executes for the Sandbox-Launcher (#329): inside one fresh Sandbox VM. It is a
// `ContainerHost` (container.ts), so the flags come from the one hardened container spec; what it adds is the
// life of the VM around that command:
//
//   prepare()  vm-prepare.sh as root (the cgroup fix, then dockerd, spike #317 F1), then the image check
//   run()      `docker run --interactive ...` as a process with a stdin pipe; the start document is written to
//              the pipe and the pipe closed. Nothing else carries it: not an argument, not the environment,
//              not a file on the VM.
//   handover   settles once the Worker has taken over (see `handover` below)
//
// A pending launch that is aborted kills the container by name; stopping the VM is the launcher's job.
import { LaunchError, type Clock } from "../core/types.ts";
import type {
  ContainerHost,
  ContainerInvocation,
  ContainerRunResult,
} from "./container.ts";
import type { SandboxVm } from "./sandbox-service.ts";

/** Installed into the golden snapshot by the pipeline (#330) from docker/sandbox/vm-prepare.sh. */
export const VM_PREPARE_PATH = "/usr/local/sbin/vm-prepare.sh";
const VM_PREPARE_TIMEOUT_MS = 60_000;
const IMAGE_CHECK_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 15_000;

export type SandboxDockerHostOptions = {
  vm: SandboxVm;
  clock: Clock;
  /** The tag the golden snapshot's image has (#330), looked up to read its id. */
  imageReference: string;
  /** The id the Dispatcher is configured with; the image in the VM must be this one. */
  imageDigest: string;
  /** How long the container must have run for the Worker to count as having taken over. */
  handoverSeconds: number;
};

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/** The `--name` of a rendered `docker run`, so a pending container can be killed. */
function containerNameOf(args: readonly string[]): string | undefined {
  const at = args.indexOf("--name");
  return at < 0 ? undefined : args[at + 1];
}

export class SandboxDockerHost implements ContainerHost {
  /**
   * Settles once the Worker has taken over: the container is running and has been given its start document, and
   * it has run for `handoverSeconds` (or it ended with 0 sooner). The Worker owns the lease from its first
   * heartbeat, which follows its startup and the fetch of its job by a few seconds; the core keeps the lease alive
   * until this settles. Rejects with a `LaunchError` when the container ends with an error first, or the launch
   * is aborted. A time is the stand-in for the Worker's own signal, which does not exist yet (follow-up).
   */
  readonly handover: Promise<void>;
  readonly #options: SandboxDockerHostOptions;
  #settle!: { resolve: () => void; reject: (error: unknown) => void };
  #settled = false;

  constructor(options: SandboxDockerHostOptions) {
    this.#options = options;
    this.handover = new Promise<void>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    this.handover.catch(() => undefined);
  }

  /** Starts the daemon and proves the image in the VM is the one the Dispatcher is configured with. */
  async prepare(signal: AbortSignal): Promise<void> {
    const { vm } = this.#options;
    const prepared = await vm.exec(
      {
        label: "vm-prepare",
        cmd: VM_PREPARE_PATH,
        args: [],
        sudo: true,
        timeoutMs: VM_PREPARE_TIMEOUT_MS,
      },
      signal,
    );
    if (prepared.exitCode !== 0)
      throw new LaunchError("docker_not_ready", { retryable: true });

    const image = await vm.exec(
      {
        label: "image-id",
        cmd: "docker",
        args: [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          this.#options.imageReference,
        ],
        sudo: true,
        timeoutMs: IMAGE_CHECK_TIMEOUT_MS,
      },
      signal,
    );
    if (image.exitCode !== 0) throw new LaunchError("image_missing");
    // The text of the answer is not logged or echoed: only whether it is the configured id.
    if (image.stdout.trim() !== this.#options.imageDigest)
      throw new LaunchError("image_mismatch");
  }

  /** Fails the handover when the container could not even be started (a refused spec, say). */
  fail(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#settle.reject(error);
  }

  async run(invocation: ContainerInvocation): Promise<ContainerRunResult> {
    const { vm, clock } = this.#options;
    // Watches the caller's signal only until the hand-over: the core never aborts a launch that succeeded, and a
    // Worker that has taken over is not tied to it.
    const pending = new AbortController();
    const forward = () => pending.abort();
    invocation.signal?.addEventListener("abort", forward, { once: true });
    if (invocation.signal?.aborted) pending.abort();
    const name = containerNameOf(invocation.args);

    try {
      const worker = await vm.start(
        {
          label: "docker-run",
          cmd: "docker",
          args: invocation.args,
          sudo: true,
        },
        pending.signal,
      );
      await worker.writeStdin(invocation.stdin);
      await worker.closeStdin();

      const exited = worker.wait();
      exited.catch(() => undefined);
      const first = await Promise.race([
        exited.then((result) => ({ ended: result })),
        clock
          .sleep(this.#options.handoverSeconds * 1000, pending.signal)
          .then(() => ({ ended: undefined })),
      ]);
      if (pending.signal.aborted) {
        await this.#kill(name);
        throw new LaunchError("launch_aborted");
      }
      if (first.ended !== undefined && first.ended.exitCode !== 0)
        throw new LaunchError("worker_exited_early", { retryable: true });
      this.#handedOver();
      invocation.signal?.removeEventListener("abort", forward);
      return await exited;
    } catch (error) {
      invocation.signal?.removeEventListener("abort", forward);
      const failure = this.#asLaunchError(error, pending.signal);
      this.fail(failure);
      throw failure;
    }
  }

  #handedOver(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#settle.resolve();
  }

  #asLaunchError(error: unknown, signal: AbortSignal): unknown {
    if (error instanceof LaunchError) return error;
    // After the hand-over the failure is the container's, not the launch's; the caller reads it as it is.
    if (this.#settled) return error;
    if (signal.aborted || isAbort(error))
      return new LaunchError("launch_aborted");
    return new LaunchError("worker_start_failed", { retryable: true });
  }

  async #kill(name: string | undefined): Promise<void> {
    if (name === undefined) return;
    try {
      await this.#options.vm.exec({
        label: "docker-kill",
        cmd: "docker",
        args: ["kill", name],
        sudo: true,
        timeoutMs: KILL_TIMEOUT_MS,
      });
    } catch {
      // Stopping the VM, which the launcher does next, ends the container anyway.
    }
  }
}
