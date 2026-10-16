// SPDX-License-Identifier: Apache-2.0

// Pins down the Sandbox target of runner/Dockerfile (#324): the Worker image of the hosted
// deployment. It is the Dynamic image's Worker layers plus labels, so it keeps the pins, the user
// layout and the fail-closed self-check of #202, and it carries no Dispatcher bundle. The built
// image is judged by docker/smoke/runner.sh in `sandbox` mode (layers shared, nothing of a
// Dispatcher inside), which CI runs; here the Dockerfile that makes it is.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dockerfile = readFileSync(`${repoRoot}runner/Dockerfile`, "utf8");

type Stage = { name: string; base: string; lines: string[] };

function stages(source: string): Stage[] {
  const lines = source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "" && !line.startsWith("#"));
  const found: Stage[] = [];
  for (const line of lines) {
    const from = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (from)
      found.push({ name: from[2] ?? "", base: from[1] ?? "", lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found;
}

function stage(name: string): Stage {
  const found = stages(dockerfile).find((entry) => entry.name === name);
  if (!found) throw new Error(`no stage ${name}`);
  return found;
}

/** The stage and every stage it is built on, base first. */
function lineage(name: string): Stage[] {
  const own = stage(name);
  const parent = stages(dockerfile).find((entry) => entry.name === own.base);
  return [...(parent ? lineage(parent.name) : []), own];
}

describe("the Sandbox image target", () => {
  // #324-T09
  it("is a stage of its own, and the default target stays the last stage", () => {
    expect(stages(dockerfile).map((entry) => entry.name)).toContain("sandbox");
    expect(stages(dockerfile).at(-1)?.name).toBe("runtime");
  });

  // #324-T09
  it("adds nothing but labels to the Worker layers of the Dynamic image, which it shares", () => {
    expect(stage("sandbox").base).toBe("dynamic-worker");
    expect(stage("dynamic").base).toBe("dynamic-worker");
    for (const target of ["sandbox", "dynamic"])
      for (const line of stage(target).lines)
        expect(line.startsWith("LABEL ")).toBe(true);
  });

  // #324-T09
  it("is not built on the dynamic target, so what is added to that one later cannot reach it", () => {
    expect(lineage("sandbox").map((entry) => entry.name)).not.toContain(
      "dynamic",
    );
    expect(lineage("sandbox").map((entry) => entry.name)).toEqual([
      "runtime-base",
      "dynamic-worker",
      "sandbox",
    ]);
  });

  // #324-T09
  it("carries no Dispatcher bundle and no Node.js", () => {
    const image = lineage("sandbox")
      .flatMap((entry) => entry.lines)
      .join("\n");

    expect(image).not.toMatch(/dispatcher/i);
    expect(image).not.toMatch(
      /\bnode(js)?\b|\bnpm\b|\bpnpm\b|COPY[^\n]*dispatcher/i,
    );
  });

  // #324-T09: the target keeps the entry point and the user of the Dynamic image.
  it("keeps the entry point of the image and ends on the unprivileged user", () => {
    const own = lineage("sandbox").flatMap((entry) => entry.lines);

    expect(own).toContain(
      'ENTRYPOINT ["/usr/bin/tini", "--", "code-reviewer-runner"]',
    );
    expect(own.filter((line) => line.startsWith("USER ")).at(-1)).toBe(
      "USER 10001:10001",
    );
  });

  // #324-T09: the image is not an alias with the Dynamic title.
  it("has its own title and enables nothing", () => {
    const labels = stage("sandbox").lines.join("\n");

    expect(labels).toContain("Sandbox");
    const settings = lineage("sandbox")
      .flatMap((entry) => entry.lines)
      .filter((line) => /^(ENV|ARG) /.test(line));
    expect(settings.join("\n")).not.toMatch(
      /RUNNER_DYNAMIC|RUNNER_OPENCODE|RUNNER_DIFF_JOB_USER|RUNNER_ADVERTISED|RUNNER_MODE/,
    );
  });
});
