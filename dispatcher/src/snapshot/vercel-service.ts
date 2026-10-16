// SPDX-License-Identifier: Apache-2.0

// The golden snapshot pipeline's port (service.ts) over the Vercel Sandbox SDK (#330). The only file of the
// pipeline that knows the platform. The SDK is handed in, so a test drives the adapter with a stand-in and
// `main.ts` is the one place that loads the real module. It is not used at job time: the Sandbox-Launcher
// (#329) has its own, narrower adapter.
import { Writable } from "node:stream";
import type {
  BuilderInfo,
  CreateVmOptions,
  ExecRequest,
  ExecResult,
  SandboxVm,
  SnapshotInfo,
  SnapshotService,
} from "./service.ts";

/** The platform credentials. Without them the SDK reads the OIDC token of the environment (`VERCEL_OIDC_TOKEN`). */
export type VercelCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

/** The part of a `Sandbox` the adapter uses. */
export interface SdkSandbox {
  readonly name: string;
  runCommand(params: {
    cmd: string;
    args: string[];
    sudo?: boolean;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdout: Writable;
    stderr: Writable;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number }>;
  writeFiles(
    files: { path: string; content: string | Uint8Array }[],
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  snapshot(opts: { expiration?: number; signal?: AbortSignal }): Promise<{
    snapshotId: string;
    status: "created" | "failed" | "deleted";
    regions: string[];
    sizeBytes: number;
  }>;
  delete(opts?: {
    deleteOrphanSnapshots?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
}

/**
 * The part of the SDK's `Sandbox` class (its static side) the adapter uses. The parameters are `object`: the
 * SDK's own are unions the adapter's literals cannot be checked against one by one, but the results and the
 * instance (`SdkSandbox`) are, and `main.ts` checks the whole against the real class with `satisfies`.
 */
export interface SandboxSdk {
  Sandbox: {
    create(params: object): Promise<SdkSandbox>;
    get(params: object): Promise<SdkSandbox>;
    list(params: Record<string, unknown>): Promise<
      AsyncIterable<{
        name: string;
        createdAt: number;
        currentSnapshotId?: string;
      }>
    >;
  };
}

class Collector extends Writable {
  text = "";
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ) {
    this.text += chunk.toString();
    done();
  }
}

function vm(sandbox: SdkSandbox): SandboxVm {
  return {
    name: sandbox.name,
    async run(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
      const stdout = new Collector();
      const stderr = new Collector();
      const finished = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", request.script],
        ...(request.sudo === undefined ? {} : { sudo: request.sudo }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.timeoutMs }),
        stdout,
        stderr,
        ...(signal ? { signal } : {}),
      });
      return {
        exitCode: finished.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
      };
    },
    async writeFile(path, content, signal) {
      await sandbox.writeFiles(
        [{ path, content }],
        signal ? { signal } : undefined,
      );
    },
    async snapshot(options, signal): Promise<SnapshotInfo> {
      const snapshot = await sandbox.snapshot({
        expiration: options.expirationMs,
        ...(signal ? { signal } : {}),
      });
      return {
        snapshotId: snapshot.snapshotId,
        status: snapshot.status,
        regions: snapshot.regions,
        sizeBytes: snapshot.sizeBytes,
      };
    },
    async destroy(options) {
      await sandbox.delete({ deleteOrphanSnapshots: options.deleteSnapshots });
    },
  };
}

export function createVercelService(
  sdk: SandboxSdk,
  credentials?: VercelCredentials,
): SnapshotService {
  const auth = credentials ? { ...credentials } : {};
  return {
    async createVm(options: CreateVmOptions, signal) {
      const sandbox = await sdk.Sandbox.create({
        ...auth,
        name: options.name,
        region: options.region,
        resources: { vcpus: options.vcpus },
        timeout: options.timeoutMs,
        tags: options.tags,
        persistent: options.persistent,
        ...(options.source ? { source: options.source } : {}),
        ...(signal ? { signal } : {}),
      });
      return vm(sandbox);
    },
    async listBuilders(namePrefix): Promise<BuilderInfo[]> {
      const builders: BuilderInfo[] = [];
      for await (const listed of await sdk.Sandbox.list({
        ...auth,
        namePrefix,
        // The platform refuses a name prefix with any other sort (HTTP 400), which made retention fail every run.
        sortBy: "name",
      })) {
        builders.push({
          name: listed.name,
          createdAt: listed.createdAt,
          ...(listed.currentSnapshotId
            ? { snapshotId: listed.currentSnapshotId }
            : {}),
        });
      }
      return builders;
    },
    async deleteBuilder(name) {
      const sandbox = await sdk.Sandbox.get({ ...auth, name });
      await sandbox.delete({ deleteOrphanSnapshots: true });
    },
  };
}
