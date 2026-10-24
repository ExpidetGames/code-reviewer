// SPDX-License-Identifier: LicenseRef-Proprietary

// The reader of the hosted lane's container records (app/e2e/helpers/hosted-containers.ts, #380) and the order the
// `docker` stand-in writes them in. A journey polls the container list while a `docker run` is still writing its
// records; the reader must never throw on one that is not complete yet.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readContainers } from "../../e2e/helpers/hosted-containers.ts";

const standIn = readFileSync(
  fileURLToPath(
    new URL("../../../fakes/sandbox/bin/docker-worker.sh", import.meta.url),
  ),
  "utf8",
);

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cr-hosted-containers-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const ARGS = "run\n--name\ncode-reviewer-worker-j1\nimage-id\nworker-once\n";

function write(base: string, files: Record<string, string>): void {
  for (const [extension, content] of Object.entries(files))
    writeFileSync(join(directory, `${base}.${extension}`), content);
}

describe("the reader of the container records", () => {
  // #380-T01
  it("does not list a container whose .args exists but whose .env is not written yet, and does not throw", () => {
    write("run-100", {
      args: ARGS,
      name: "code-reviewer-worker-j1",
      pid: "7\n",
    });

    expect(readContainers(directory)).toEqual([]);
  });

  // #380-T01
  it("does not list a container that has only its .args", () => {
    write("run-100", { args: ARGS });

    expect(readContainers(directory)).toEqual([]);
  });

  // #380-T01
  it("lists the complete containers and skips the incomplete one between them", () => {
    const complete = { name: "n", pid: "5\n", env: "A=1\n" };
    write("run-100", { args: ARGS, ...complete });
    write("run-200", { args: ARGS, name: "n2" });
    write("run-300", { args: ARGS, ...complete });

    expect(readContainers(directory).map((c) => c.index)).toEqual([0, 1]);
  });

  // #380-T02
  it("lists a container with its name, arguments, environment and process id once all files are there", () => {
    write("run-100", {
      args: ARGS,
      name: "code-reviewer-worker-j1",
      pid: "4242\n",
      env: "HOME=/h\nPATH=/p\n",
      log: "stderr text",
    });

    const [container, ...rest] = readContainers(directory);

    expect(rest).toEqual([]);
    expect(container).toMatchObject({
      index: 0,
      mode: "worker-once",
      name: "code-reviewer-worker-j1",
      args: [
        "run",
        "--name",
        "code-reviewer-worker-j1",
        "image-id",
        "worker-once",
      ],
      environment: "HOME=/h\nPATH=/p\n",
      pid: 4242,
    });
    expect(container?.log()).toBe("stderr text");
  });

  // #380-T02
  it("is empty when the records directory does not exist", () => {
    expect(readContainers(join(directory, "missing"))).toEqual([]);
  });
});

describe("the order the docker stand-in writes a container's records in", () => {
  const written = (extension: string): number =>
    standIn.indexOf(`"$dir/run-$n.${extension}"`);

  // #380-T03
  it("writes run-<n>.args after .name, .pid and .env", () => {
    const args = standIn.indexOf('"$dir/run-$n.args"');
    expect(args).toBeGreaterThan(-1);
    for (const extension of ["name", "pid", "env"]) {
      expect(written(extension)).toBeGreaterThan(-1);
      expect(written(extension)).toBeLessThan(args);
    }
  });

  // #380-T03
  it("makes .args appear by a rename of a temporary file, so a reader never sees a partial one", () => {
    expect(standIn).toMatch(/mv [^\n]*run-\$n\.args\.tmp[^\n]*run-\$n\.args"/);
  });
});
