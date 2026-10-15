// SPDX-License-Identifier: Apache-2.0

// Pins down docker/sandbox/vm-prepare.sh as a file (#325, spike #317 finding F1): the host
// preparation a Sandbox VM needs so that `docker run` with the memory and pids limits of the hardened
// container spec works. Whether it works on a real VM is the golden snapshot pipeline's check (#330);
// here only what must not drift is fixed: it stops on any error, makes the cgroup root a domain with
// the memory controller before it starts the daemon, and does not start the daemon twice.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
  it("waits for the daemon and fails when it does not become ready", () => {
    expect(code).toContain("docker info");
    expect(code).toContain("exit 0");
    expect(code).toMatch(/did not become ready" >&2; exit 1/);
  });

  // #325-extra-F1
  it("holds no secret and no host-specific name", () => {
    expect(script).not.toMatch(/token|secret|password|credential/i);
  });
});
