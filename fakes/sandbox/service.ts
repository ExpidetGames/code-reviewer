// SPDX-License-Identifier: Apache-2.0

// An in-process double of the Sandbox platform for the Sandbox-Launcher (#329). It speaks the port of
// dispatcher/src/launchers/sandbox-service.ts, which it matches structurally: this file imports nothing from the
// Dispatcher, as fakes/ is shared by every project. A VM here is a record, not a machine: no command runs.
//
// A test scripts the answer of a command with `onExec` (matched by the step label or by a regular expression over
// the command line); anything unscripted ends with exit code 0 and no output. A started process (the Worker's
// `docker run`) stays running until the test ends it with `exitProcess`, or until its VM is stopped, which ends it
// with 137 like a killed process. Everything a caller sends except the stdin of a process is kept as text in
// `requestText()`, so a test can prove that a secret never left the process any other way than on that pipe.
// The golden snapshot pipeline's double is `fakes/vercel-sandbox/`; the two do not share state. See README.md.

export type FakeCreateOptions = {
  name: string;
  snapshotId: string;
  region: string;
  vcpus: number;
  timeoutMs: number;
  tags: Readonly<Record<string, string>>;
  persistent: boolean;
};

export type FakeExecRequest = {
  label: string;
  cmd: string;
  args: readonly string[];
  sudo?: boolean;
  timeoutMs?: number;
};

export type FakeExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type FakeExecCall = FakeExecRequest & { vm: string };

export type ExecHandler =
  Partial<FakeExecResult> | ((call: FakeExecCall) => Partial<FakeExecResult>);

type Rule = {
  match: string | RegExp;
  handler: ExecHandler;
  remaining: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type FakeVmRecord = {
  name: string;
  options: FakeCreateOptions;
  state: "running" | "stopped";
};

type FakeProcessRecord = {
  vm: string;
  label: string;
  stdin: string;
  stdinClosed: boolean;
  exit: Deferred<{ exitCode: number }>;
  ended: boolean;
};

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class FakeSandboxService {
  /** Every observable action in order: `create:<vm>`, `exec:<label>`, `start:<label>`, `stdin:<vm>`, `stop:<vm>`. */
  readonly events: string[] = [];
  readonly creates: FakeCreateOptions[] = [];
  readonly execs: FakeExecCall[] = [];
  readonly starts: FakeExecCall[] = [];
  /** Every name `stop` was called with, in order. */
  readonly stops: string[] = [];
  readonly vms = new Map<string, FakeVmRecord>();
  private readonly processes: FakeProcessRecord[] = [];
  private readonly rules: Rule[] = [];
  private createError: Error | undefined;
  private createGate: Deferred<void> | undefined;
  private stopError: Error | undefined;

  // ---- scripting -------------------------------------------------------------------------------

  /** Answers the commands with this label (or whose command line matches) until `times` answers were given. */
  onExec(
    match: string | RegExp,
    handler: ExecHandler,
    options: { times?: number } = {},
  ): void {
    this.rules.unshift({
      match,
      handler,
      remaining: options.times ?? Infinity,
    });
  }

  /** The next `create` throws this error (a `SandboxServiceError` of the Dispatcher, brought by the test). */
  failNextCreate(error: Error): void {
    this.createError = error;
  }

  /** Every following `stop` throws this error. */
  failStops(error: Error): void {
    this.stopError = error;
  }

  /** The next `create` waits until `release()` is called or its signal aborts. */
  holdNextCreate(): { release: () => void } {
    const gate = deferred<void>();
    this.createGate = gate;
    return { release: () => gate.resolve() };
  }

  /** Ends the running process of a VM (the first one with this label, or the first running one). */
  exitProcess(vm: string, exitCode: number, label?: string): void {
    const process = this.processes.find(
      (candidate) =>
        candidate.vm === vm &&
        !candidate.ended &&
        (label === undefined || candidate.label === label),
    );
    if (process === undefined)
      throw new Error(`No running process in ${vm} to end.`);
    this.end(process, exitCode);
  }

  // ---- what the tests look at ------------------------------------------------------------------

  /** What was written to the stdin of the processes of a VM, in one text. */
  stdinOf(vm: string): string {
    return this.processes
      .filter((process) => process.vm === vm)
      .map((process) => process.stdin)
      .join("");
  }

  /** Whether the stdin of the VM's process was closed (the Worker reads to the end of it). */
  stdinClosed(vm: string): boolean {
    return this.processes.some(
      (process) => process.vm === vm && process.stdinClosed,
    );
  }

  /** Every request except process stdin, as one text: create options, command lines and stop calls. */
  requestText(): string {
    return JSON.stringify({
      creates: this.creates,
      execs: this.execs,
      starts: this.starts,
      stops: this.stops,
    });
  }

  /** The VMs that were created and not stopped. */
  running(): string[] {
    return [...this.vms.values()]
      .filter((vm) => vm.state === "running")
      .map((vm) => vm.name);
  }

  // ---- the port --------------------------------------------------------------------------------

  async create(options: FakeCreateOptions, signal?: AbortSignal) {
    this.events.push(`create:${options.name}`);
    this.creates.push(structuredClone(options));
    if (this.createError !== undefined) {
      const error = this.createError;
      this.createError = undefined;
      throw error;
    }
    if (this.createGate !== undefined) {
      const gate = this.createGate;
      this.createGate = undefined;
      await new Promise<void>((resolve, reject) => {
        void gate.promise.then(resolve);
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });
    }
    if (this.vms.has(options.name))
      throw new Error(`The sandbox name ${options.name} is taken.`);
    const record: FakeVmRecord = {
      name: options.name,
      options: structuredClone(options),
      state: "running",
    };
    this.vms.set(options.name, record);
    return this.vm(record);
  }

  async stop(name: string): Promise<void> {
    this.events.push(`stop:${name}`);
    this.stops.push(name);
    if (this.stopError !== undefined) throw this.stopError;
    const record = this.vms.get(name);
    if (record === undefined || record.state === "stopped") return;
    record.state = "stopped";
    for (const process of this.processes)
      if (process.vm === name && !process.ended) this.end(process, 137);
  }

  // ---- internals -------------------------------------------------------------------------------

  private end(process: FakeProcessRecord, exitCode: number): void {
    process.ended = true;
    process.exit.resolve({ exitCode });
  }

  private answer(call: FakeExecCall): FakeExecResult {
    const line = `${call.cmd} ${call.args.join(" ")}`;
    const rule = this.rules.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (typeof candidate.match === "string"
          ? candidate.match === call.label
          : candidate.match.test(line)),
    );
    const given =
      rule === undefined
        ? {}
        : typeof rule.handler === "function"
          ? rule.handler(call)
          : rule.handler;
    if (rule !== undefined) rule.remaining -= 1;
    return { exitCode: 0, stdout: "", stderr: "", ...given };
  }

  private requireRunning(record: FakeVmRecord): void {
    if (record.state !== "running")
      throw new Error(`The sandbox ${record.name} is stopped.`);
  }

  private vm(record: FakeVmRecord) {
    return {
      name: record.name,
      exec: (request: FakeExecRequest, signal?: AbortSignal) => {
        this.requireRunning(record);
        if (signal?.aborted) return Promise.reject(abortError());
        this.events.push(`exec:${request.label}`);
        const call: FakeExecCall = { ...request, vm: record.name };
        this.execs.push(structuredClone(call));
        return Promise.resolve(this.answer(call));
      },
      start: (request: FakeExecRequest) => {
        this.requireRunning(record);
        this.events.push(`start:${request.label}`);
        const call: FakeExecCall = { ...request, vm: record.name };
        this.starts.push(structuredClone(call));
        const process: FakeProcessRecord = {
          vm: record.name,
          label: request.label,
          stdin: "",
          stdinClosed: false,
          exit: deferred(),
          ended: false,
        };
        this.processes.push(process);
        return Promise.resolve({
          writeStdin: (data: string) => {
            this.events.push(`stdin:${record.name}`);
            process.stdin += data;
            return Promise.resolve();
          },
          closeStdin: () => {
            process.stdinClosed = true;
            return Promise.resolve();
          },
          wait: (signal?: AbortSignal) =>
            signal === undefined
              ? process.exit.promise
              : Promise.race([
                  process.exit.promise,
                  new Promise<never>((_resolve, reject) => {
                    if (signal.aborted) reject(abortError());
                    signal.addEventListener(
                      "abort",
                      () => reject(abortError()),
                      {
                        once: true,
                      },
                    );
                  }),
                ]),
        });
      },
    };
  }
}
