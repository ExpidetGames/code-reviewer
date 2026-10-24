// SPDX-License-Identifier: LicenseRef-Proprietary

// The port between the golden snapshot pipeline and the Sandbox platform (#330). The pipeline never
// imports the platform SDK: `vercel-service.ts` adapts the SDK to this port, and `fakes/vercel-sandbox` is a
// double of it for the tests. The Sandbox-Launcher (#329) has a port of its own for the per-job VM.

export type ExecRequest = {
  /** A stable name of the step; the fake and the logs address a command by it, never by its text. */
  label: string;
  /** A bash script, run as `bash -c`. */
  script: string;
  sudo?: boolean;
  /** Extra environment of this command. The pipeline passes none today; no secret ever goes through here. */
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SnapshotInfo = {
  snapshotId: string;
  status: "created" | "failed" | "deleted";
  /** Every region the snapshot is available in. */
  regions: readonly string[];
  sizeBytes?: number;
};

export type CreateVmOptions = {
  /** A unique name; the builder's name carries the build time and is how retention finds it. */
  name: string;
  region: string;
  vcpus: number;
  timeoutMs: number;
  tags: Readonly<Record<string, string>>;
  /** false for a VM that must leave nothing behind when it stops (the check VM). */
  persistent: boolean;
  /** Start from this snapshot instead of the platform image. */
  source?: { type: "snapshot"; snapshotId: string };
};

export interface SandboxVm {
  readonly name: string;
  run(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  /** Writes a file as the VM's default user. A file for root is moved with `sudo install` by a command. */
  writeFile(
    path: string,
    content: Uint8Array | string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Snapshots the VM. The VM is stopped by it. `expirationMs: 0` is no expiry. */
  snapshot(
    options: { expirationMs: number },
    signal?: AbortSignal,
  ): Promise<SnapshotInfo>;
  /** Deletes the VM; `deleteSnapshots` also deletes the snapshots that only it uses. */
  destroy(options: { deleteSnapshots: boolean }): Promise<void>;
}

export type BuilderInfo = {
  name: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** The snapshot the builder holds, if it holds one. */
  snapshotId?: string;
};

export interface SnapshotService {
  createVm(options: CreateVmOptions, signal?: AbortSignal): Promise<SandboxVm>;
  /** The builders of earlier runs, found by their name prefix. */
  listBuilders(namePrefix: string): Promise<readonly BuilderInfo[]>;
  /** Deletes a builder together with the snapshot it holds. */
  deleteBuilder(name: string): Promise<void>;
}
