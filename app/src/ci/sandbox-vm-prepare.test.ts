// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down docker/sandbox/vm-prepare.sh as a file (#325, spike #317 finding F1): the host
// preparation a Sandbox VM needs so that `docker run` with the memory and pids limits of the hardened
// container spec works. Whether it works on a real VM is the golden snapshot pipeline's check (#330);
// here only what must not drift is fixed: it stops on any error, makes the cgroup root a domain with
// the memory controller before it starts the daemon, and does not start the daemon twice.
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const path = `${repoRoot}docker/sandbox/vm-prepare.sh`;
const script = readFileSync(path, "utf8");
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("docker/sandbox/vm-prepare.sh", () => {
  // #325-extra-F1
  it("is executable and stops on any error", () => {
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(code).toContain("set -euo pipefail");
  });

  // #325-extra-F1
  it("prepares the cgroup root before it starts the daemon", () => {
    const enable = code.indexOf('echo "+memory +io +cpu +cpuset +pids"');
    const daemon = code.indexOf("dockerd");

    expect(enable).toBeGreaterThan(-1);
    expect(daemon).toBeGreaterThan(enable);
    // The threaded controllers are turned off, and the processes of the root moved, before.
    expect(code.indexOf('echo "-cpuset -cpu -pids"')).toBeLessThan(
      code.indexOf("vm.slice/cgroup.procs"),
    );
    expect(code.indexOf("vm.slice/cgroup.procs")).toBeLessThan(enable);
  });

  // #325-extra-F1
  it("leaves a root that is already prepared alone", () => {
    expect(code).toContain('"$(cat cgroup.type)" != "domain"');
    expect(code).toContain("grep -qw memory cgroup.subtree_control");
  });

  // #325-extra-F1
  it("does not start a second daemon when one already answers", () => {
    const guard = code.indexOf("docker info >/dev/null 2>&1 && exit 0");
    const start = code.indexOf("nohup setsid dockerd");

    expect(guard).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(guard);
  });

  // #325-extra-F1
  it("waits for the daemon and fails when it does not become ready", () => {
    expect(code).toContain("docker info");
    expect(code).toContain("exit 0");
    expect(code).toMatch(/did not become ready" >&2; exit 1/);
  });

  // #325-extra-F1
  it("holds no secret and no host-specific name", () => {
    expect(script).not.toMatch(/token|secret|password|credential/i);
  });

  // #473-T05
  it("does not give the platform's start-up work a single try at the cgroup root", () => {
    // The write that enables the controllers fails with EBUSY while the VM's own start-up processes are still
    // being created in the root: the preparation is a function that is tried again, never a bare sequence.
    expect(code).toMatch(/prepare_cgroup\(\)/);
    expect(code).toContain("VM_PREPARE_TRIES");
  });
});

// A stand-in for the cgroup root in a temporary directory. `cgroup.subtree_control` is a directory while the "VM is
// still starting": every write to it fails, as the EBUSY of the real file does, until the test makes it a file.
describe("docker/sandbox/vm-prepare.sh against a busy cgroup root", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "vm-prepare-"));
    roots.push(dir);
    const cgroup = join(dir, "cgroup");
    const bin = join(dir, "bin");
    mkdirSync(cgroup);
    mkdirSync(bin);
    writeFileSync(join(cgroup, "cgroup.type"), "domain\n");
    writeFileSync(join(cgroup, "cgroup.procs"), "");
    mkdirSync(join(cgroup, "cgroup.subtree_control"));
    // `docker info` answers at once: the daemon part of the script is not what is under test.
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "docker"), 0o755);
    return { cgroup, bin };
  }

  function run(
    fx: { cgroup: string; bin: string },
    tries: number,
    whileRunning?: () => void,
  ): Promise<{ code: number | null; stderr: string; ms: number }> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn("bash", [path], {
        env: {
          ...process.env,
          PATH: `${fx.bin}:${process.env.PATH ?? ""}`,
          VM_PREPARE_CGROUP_ROOT: fx.cgroup,
          VM_PREPARE_TRIES: String(tries),
          VM_PREPARE_RETRY_SECONDS: "0.05",
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ code, stderr, ms: Date.now() - started }),
      );
      whileRunning?.();
    });
  }

  // #473-T01
  it("tries again until the root accepts the controllers and then ends 0", async () => {
    const fx = fixture();
    const control = join(fx.cgroup, "cgroup.subtree_control");

    const result = await run(fx, 100, () => {
      setTimeout(() => {
        rmdirSync(control);
        writeFileSync(control, "");
      }, 400);
    });

    expect(result.stderr).not.toContain("cgroup_root_busy");
    expect(result.code).toBe(0);
    expect(readFileSync(control, "utf8")).toContain(
      "+memory +io +cpu +cpuset +pids",
    );
  });

  // #473-T02
  it("gives up after a bounded number of tries and names the cause on stderr", async () => {
    const fx = fixture();
    writeFileSync(join(fx.cgroup, "cgroup.procs"), "");

    const result = await run(fx, 3);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("vm-prepare: cgroup_root_busy tries=3");
    expect(result.stderr).toMatch(/last_error=.*(directory|busy)/i);
    expect(result.ms).toBeLessThan(10_000);
  });
});
