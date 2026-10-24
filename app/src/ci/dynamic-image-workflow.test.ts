// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how CI proves the Dynamic runner image (#202): a job of its own builds the `dynamic`
// target of runner/Dockerfile and runs the smoke test in `dynamic` mode (the exact pinned engine and
// ripgrep, the engine user, the startup self-check advertising `opencode` and each broken
// prerequisite not advertising it). The default image keeps its own job and its own mode, which
// proves it holds nothing of the engine. Docker itself runs in CI; here the wiring is judged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = { jobs: Record<string, Job> };

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const smoke = read("docker/smoke/runner.sh");
const compose = parse(read("compose.dynamic.yml")) as {
  services: Record<string, { cap_add?: string[] }>;
};

function job(id: string): Job {
  const found = ci.jobs[id];
  if (!found) throw new Error(`ci.yml has no job "${id}"`);
  return found;
}

describe("the CI job of the Dynamic runner image", () => {
  const dynamic = () => job("image-runner-dynamic");

  // #202-T01
  it("builds the dynamic target on pull requests, loads it and does not push", () => {
    const builds = (dynamic().steps ?? []).filter((step) =>
      step.uses?.startsWith("docker/build-push-action@"),
    );

    expect(builds).toHaveLength(1);
    expect(builds[0]?.with).toMatchObject({
      context: ".",
      file: "runner/Dockerfile",
      target: "dynamic",
      load: true,
      push: false,
      tags: "code-reviewer-runner-dynamic:ci",
    });
  });

  // #202-T01
  it("smoke tests the image it just built in dynamic mode", () => {
    const commands = (dynamic().steps ?? []).flatMap((step) =>
      (step.run ?? "").split("\n").map((line) => line.trim()),
    );

    expect(commands).toContain(
      "docker/smoke/runner.sh code-reviewer-runner-dynamic:ci dynamic",
    );
  });

  // #202-T01
  it("runs under the same conditions as the default runner image job and has no more rights", () => {
    expect(dynamic().if).toBe(job("image-runner").if);
    expect(dynamic().permissions).toBeUndefined();
    const text = JSON.stringify(dynamic());
    expect(text).not.toMatch(/docker\s+(push|login)|login-action/);
  });

  // #202-T01
  it("is part of the aggregate check", () => {
    expect(job("ci-passed").needs).toContain("image-runner-dynamic");
  });

  // #202-T03
  it("leaves the default runner image job on the default smoke mode", () => {
    const commands = (job("image-runner").steps ?? []).flatMap((step) =>
      (step.run ?? "").split("\n").map((line) => line.trim()),
    );

    expect(commands).toContain(
      "docker/smoke/runner.sh code-reviewer-runner:ci",
    );
  });
});

describe("the smoke test of the runner image", () => {
  // #202-T01 #202-T03
  it("has a mode for each image and refuses any other", () => {
    expect(smoke).toContain("[diff|dynamic|sandbox]");
    expect(smoke).toMatch(/unknown mode/);
  });

  // #202-T01: the container it starts is created like the one compose.dynamic.yml creates.
  it("starts the capable runner with exactly the capabilities of compose.dynamic.yml", () => {
    const block = /dynamic_caps=\(([\s\S]*?)\n\)/.exec(smoke)?.[1] ?? "";
    const added = [...block.matchAll(/--cap-add (\w+)/g)]
      .map((match) => match[1])
      .sort();

    expect(added).toEqual(
      [...(compose.services["runner-dynamic"]?.cap_add ?? [])].sort(),
    );
    expect(block).toContain("--cap-drop ALL");
    expect(block).toContain("--security-opt no-new-privileges:true");
    expect(block).toContain("--user 0:0");
  });

  // #202-T09
  it("proves a failing prerequisite for each of: no rule capability, no engine user, wrong binary", () => {
    for (const reason of [
      "network_rules_not_installed",
      "engine_user_invalid",
      "engine_binary_",
    ]) {
      expect(smoke, reason).toContain(reason);
    }
    // Every run is without any network, so nothing can be downloaded or reached.
    expect(smoke).toContain("--network none");
  });

  // #202-T01: the engine's version is asked as the engine user, offline.
  it("asks the engine for its version as the engine user with no network", () => {
    expect(smoke).toMatch(
      /--network none --user 10101:10101[^\n]*\\\n[^\n]*opencode/,
    );
  });

  // #202-T01: "no setuid binary added" is a measurement, not a reading of the package list.
  it("compares the setuid and setgid binaries of the Dynamic image with those of its base image", () => {
    expect(smoke).toMatch(/-perm -4000/);
    expect(smoke).toMatch(/-perm -2000/);
    // The base image is the one the Dockerfile pins, read from its ARG.
    expect(smoke).toContain("ARG PYTHON_IMAGE=");
    expect(smoke).toMatch(/setuid_in_image\s+"\$base_image"/);
    expect(smoke).toMatch(/setuid_in_image\s+"\$image"/);
    expect(smoke).toMatch(/added setuid or setgid/);
  });
});
