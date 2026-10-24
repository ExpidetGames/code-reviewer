// SPDX-License-Identifier: LicenseRef-Proprietary

// A double of the Sandbox platform for automated tests (#330, to be extended by the Sandbox-Launcher, #329).
// It runs in the test process and speaks the port of dispatcher/src/snapshot/service.ts, which it
// matches structurally: this file imports nothing from the Dispatcher, as fakes/ is shared by every project.
//
// It runs no command. A command's result is scripted with `onExec`, matched by the step label the caller gave
// it (or by a regular expression over the script); anything unscripted ends with exit code 0 and no output.
// Everything a caller sends (scripts, environment, file contents, create options) is kept as text in
// `requestText()`, so a test can prove that a secret never left the process. See README.md.

export type FakeExecRequest = {
  label: string;
  script: string;
  sudo?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
};
export type FakeExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
export type FakeSnapshotInfo = {
  snapshotId: string;
  status: "created" | "failed" | "deleted";
  regions: readonly string[];
  sizeBytes?: number;
};
export type FakeCreateVmOptions = {
  name: string;
  region: string;
  vcpus: number;
  timeoutMs: number;
  tags: Readonly<Record<string, string>>;
  persistent: boolean;
  source?: { type: "snapshot"; snapshotId: string };
};

export type FakeExecCall = FakeExecRequest & { vm: string };
export type ExecHandler =
  | Partial<FakeExecResult>
  | ((
      call: FakeExecCall,
    ) => Partial<FakeExecResult> | Promise<Partial<FakeExecResult>>);

type Rule = {
  match: string | RegExp;
  handler: ExecHandler;
  /** "builder" and "clone" restrict the rule to a VM created without or with a snapshot source. */
  on?: "builder" | "clone";
  remaining: number;
};

export type FakeVmRecord = {
  name: string;
  options: FakeCreateVmOptions;
  kind: "builder" | "clone";
  createdAt: number;
  state: "running" | "stopped" | "deleted";
  files: Map<string, string>;
  snapshotId?: string;
};

export type FakeSandboxOptions = {
  /** The clock for `createdAt`; the default counts up by one second per call. */
  now?: () => number;
  /** The regions the snapshots are available in (default `["fra1"]`). */
  snapshotRegions?: readonly string[];
};

export class FakeSandboxService {
  /** Every command, in order. */
  readonly calls: FakeExecCall[] = [];
  /** Every observable action, in order: `create:<vm>`, `exec:<label>`, `write:<path>`, `snapshot:<id>`, `destroy:<vm>`. */
  readonly events: string[] = [];
  readonly vms = new Map<string, FakeVmRecord>();
  readonly snapshots = new Map<string, FakeSnapshotInfo>();
  private readonly rules: Rule[] = [];
  private readonly requests: string[] = [];
  private readonly now: () => number;
  private readonly snapshotRegions: readonly string[];
  private nextSnapshot = 1;
  private clock = 1_700_000_000_000;
  private createError: Error | undefined;
  private snapshotError: Error | undefined;
  private snapshotStatus: FakeSnapshotInfo["status"] = "created";
  private destroyErrorFor = new Set<string>();

  constructor(options: FakeSandboxOptions = {}) {
    this.snapshotRegions = options.snapshotRegions ?? ["fra1"];
    this.now =
      options.now ??
      (() => {
        this.clock += 1000;
        return this.clock;
      });
  }

  // ---- scripting -------------------------------------------------------------------------------

  /** Answers the commands with this label (or whose script matches) until `times` answers were given. */
  onExec(
    match: string | RegExp,
    handler: ExecHandler,
    options: { on?: "builder" | "clone"; times?: number } = {},
  ): void {
    this.rules.unshift({
      match,
      handler,
      on: options.on,
      remaining: options.times ?? Infinity,
    });
  }

  failNextCreate(error: Error): void {
    this.createError = error;
  }
  failNextSnapshot(error: Error): void {
    this.snapshotError = error;
  }
  /** The next snapshot ends in this status instead of `created`. */
  setNextSnapshotStatus(status: FakeSnapshotInfo["status"]): void {
    this.snapshotStatus = status;
  }
  /** Deleting this VM fails (a platform error), as many times as it is asked. */
  failDestroyOf(name: string): void {
    this.destroyErrorFor.add(name);
  }

  /** A builder of an earlier run, with or without a snapshot, for a retention test. */
  seedBuilder(
    name: string,
    createdAt: number,
    withSnapshot = true,
  ): string | undefined {
    const record: FakeVmRecord = {
      name,
      options: {
        name,
        region: "fra1",
        vcpus: 2,
        timeoutMs: 1,
        tags: {},
        persistent: true,
      },
      kind: "builder",
      createdAt,
      state: "stopped",
      files: new Map(),
    };
    if (withSnapshot) {
      const snapshot = this.newSnapshot("created");
      record.snapshotId = snapshot.snapshotId;
    }
    this.vms.set(name, record);
    return record.snapshotId;
  }

  // ---- inspection ------------------------------------------------------------------------------

  /** All that was sent to the platform, as one text: scripts, environment, file contents, create options. */
  requestText(): string {
    return this.requests.join("\n");
  }
  liveSnapshotIds(): string[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.status === "created")
      .map((snapshot) => snapshot.snapshotId);
  }
  liveVmNames(): string[] {
    return [...this.vms.values()]
      .filter((vm) => vm.state !== "deleted")
      .map((vm) => vm.name);
  }
  callsFor(label: string): FakeExecCall[] {
    return this.calls.filter((call) => call.label === label);
  }

  // ---- the port --------------------------------------------------------------------------------

  async createVm(options: FakeCreateVmOptions) {
    this.requests.push(`create ${JSON.stringify(options)}`);
    if (this.createError) {
      const error = this.createError;
      this.createError = undefined;
      throw error;
    }
    if (
      this.vms.get(options.name)?.state !== undefined &&
      this.vms.get(options.name)?.state !== "deleted"
    )
      throw new Error("sandbox_name_taken");
    if (options.source) {
      const source = this.snapshots.get(options.source.snapshotId);
      if (!source || source.status !== "created")
        throw new Error("snapshot_not_found");
    }
    const record: FakeVmRecord = {
      name: options.name,
      options,
      kind: options.source ? "clone" : "builder",
      createdAt: this.now(),
      state: "running",
      files: new Map(),
    };
    this.vms.set(options.name, record);
    this.events.push(`create:${options.name}`);
    return this.handle(record);
  }

  async listBuilders(namePrefix: string) {
    return [...this.vms.values()]
      .filter(
        (vm) =>
          vm.kind === "builder" &&
          vm.state !== "deleted" &&
          vm.name.startsWith(namePrefix),
      )
      .map((vm) => ({
        name: vm.name,
        createdAt: vm.createdAt,
        ...(vm.snapshotId ? { snapshotId: vm.snapshotId } : {}),
      }));
  }

  async deleteBuilder(name: string) {
    await this.destroy(name, { deleteSnapshots: true });
  }

  // ---- internals -------------------------------------------------------------------------------

  private newSnapshot(status: FakeSnapshotInfo["status"]): FakeSnapshotInfo {
    const snapshot: FakeSnapshotInfo = {
      snapshotId: `snap_fake_${this.nextSnapshot++}`,
      status,
      regions: this.snapshotRegions,
      sizeBytes: 1_860_000_000,
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  private async destroy(name: string, options: { deleteSnapshots: boolean }) {
    this.requests.push(`destroy ${name} ${JSON.stringify(options)}`);
    if (this.destroyErrorFor.has(name)) throw new Error("platform_error");
    const record = this.vms.get(name);
    if (!record || record.state === "deleted") return;
    record.state = "deleted";
    this.events.push(`destroy:${name}`);
    if (options.deleteSnapshots && record.snapshotId) {
      const snapshot = this.snapshots.get(record.snapshotId);
      if (snapshot) snapshot.status = "deleted";
    }
  }

  private handle(record: FakeVmRecord) {
    const requireRunning = () => {
      if (record.state !== "running") throw new Error("sandbox_not_running");
    };
    return {
      name: record.name,
      run: async (request: FakeExecRequest): Promise<FakeExecResult> => {
        requireRunning();
        const call: FakeExecCall = { ...request, vm: record.name };
        this.calls.push(call);
        this.events.push(`exec:${request.label}`);
        this.requests.push(
          `exec ${request.label} sudo=${request.sudo ?? false} env=${JSON.stringify(request.env ?? {})}\n${request.script}`,
        );
        const rule = this.rules.find(
          (candidate) =>
            candidate.remaining > 0 &&
            (candidate.on === undefined || candidate.on === record.kind) &&
            (typeof candidate.match === "string"
              ? candidate.match === request.label
              : candidate.match.test(request.script)),
        );
        if (!rule) return { exitCode: 0, stdout: "", stderr: "" };
        rule.remaining -= 1;
        const answer =
          typeof rule.handler === "function"
            ? await rule.handler(call)
            : rule.handler;
        return { exitCode: 0, stdout: "", stderr: "", ...answer };
      },
      writeFile: async (path: string, content: Uint8Array | string) => {
        requireRunning();
        const text =
          typeof content === "string"
            ? content
            : Buffer.from(content).toString("latin1");
        record.files.set(path, text);
        this.events.push(`write:${path}`);
        this.requests.push(`write ${path}\n${text}`);
      },
      snapshot: async (options: {
        expirationMs: number;
      }): Promise<FakeSnapshotInfo> => {
        requireRunning();
        this.requests.push(
          `snapshot ${record.name} ${JSON.stringify(options)}`,
        );
        if (this.snapshotError) {
          const error = this.snapshotError;
          this.snapshotError = undefined;
          throw error;
        }
        const snapshot = this.newSnapshot(this.snapshotStatus);
        this.snapshotStatus = "created";
        record.snapshotId = snapshot.snapshotId;
        record.state = "stopped";
        this.events.push(`snapshot:${snapshot.snapshotId}`);
        return snapshot;
      },
      destroy: (options: { deleteSnapshots: boolean }) =>
        this.destroy(record.name, options),
    };
  }
}
