// SPDX-License-Identifier: Apache-2.0

// Pins down how CI proves the Sandbox image and the entry modes of the runner image (#324): a job of
// its own builds the `sandbox` target (and the `dynamic` one, to compare their layers) and runs the
// smoke test in `sandbox` mode; the smoke test proves the three modes (`probe`, `worker-once`,
// `dispatch`), the legacy default and the stable reasons of a failed probe. Docker itself runs in CI;
// here the wiring is judged.
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
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = { jobs: Record<string, Job> };

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const smoke = read("docker/smoke/runner.sh");
const makefile = read("Makefile");

function job(id: string): Job {
  const found = ci.jobs[id];
  if (!found) throw new Error(`ci.yml has no job "${id}"`);
  return found;
}

describe("the CI job of the Sandbox image", () => {
  const sandbox = () => job("image-runner-sandbox");

  // #324-T09
  it("builds the sandbox target and the dynamic target, loads them and does not push", () => {
    const builds = (sandbox().steps ?? []).filter((step) =>
      step.uses?.startsWith("docker/build-push-action@"),
    );

    expect(builds.map((step) => step.with?.["target"])).toEqual([
      "dynamic",
      "sandbox",
    ]);
    for (const build of builds)
      expect(build.with).toMatchObject({
        context: ".",
        file: "runner/Dockerfile",
        load: true,
        push: false,
      });
    expect(builds[1]?.with?.["tags"]).toBe("code-reviewer-runner-sandbox:ci");
  });

  // #324-T09
  it("smoke tests the sandbox image in sandbox mode against the dynamic image", () => {
    const commands = (sandbox().steps ?? []).flatMap((step) =>
      (step.run ?? "").split("\n").map((line) => line.trim()),
    );

    expect(commands).toContain(
      "docker/smoke/runner.sh code-reviewer-runner-sandbox:ci sandbox code-reviewer-runner-dynamic:ci",
    );
  });

  // #324-T04: the smoke test runs the fake App, which is Node.
  it("has the Node version of the repository for the fake App, as the other jobs that run the smoke test", () => {
    for (const id of ["image-runner-sandbox", "image-runner-dynamic"]) {
      const setup = (job(id).steps ?? []).find((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      );
      expect(setup?.with, id).toMatchObject({ "node-version-file": ".nvmrc" });
    }
  });

  // #324-T09
  it("runs under the same conditions as the Dynamic image job, has no more rights and no login", () => {
    expect(sandbox().if).toBe(job("image-runner-dynamic").if);
    expect(sandbox().permissions).toBeUndefined();
    expect(JSON.stringify(sandbox())).not.toMatch(
      /docker\s+(push|login)|login-action/,
    );
  });

  // #324-T09
  it("is part of the aggregate check and is not published", () => {
    expect(job("ci-passed").needs).toContain("image-runner-sandbox");
    expect(read(".github/workflows/publish-images.yml")).not.toContain(
      "sandbox",
    );
  });

  it("is built and smoke tested by make test-images as well", () => {
    expect(makefile).toContain("--target sandbox");
    expect(makefile).toContain(
      "docker/smoke/runner.sh code-reviewer-runner-sandbox:local sandbox code-reviewer-runner-dynamic:local",
    );
  });
});

describe("the smoke test of the entry modes", () => {
  // #324-T01 #324-T03 #324-T04 #324-T08
  it("proves probe, worker-once, dispatch and the legacy default in every image", () => {
    expect(smoke).toContain("assert_probe pr-agent not_a_dynamic_runner");
    expect(smoke).toContain("worker_once_fake_app.py");
    expect(smoke).toContain("RUNNER_MODE=legacy");
    expect(smoke).toContain("dispatcher_bundle_missing");
    expect(smoke).toContain("worker-reap");
  });

  // #324-T01
  it("asks for the verdict of a container made with the production flags and expects opencode", () => {
    expect(smoke).toContain(
      'assert_probe "pr-agent,opencode" "" "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}"',
    );
  });

  // #324-T02
  it("proves each missing property with its stable reason: capability, nft, writable root", () => {
    for (const reason of [
      "network_rules_not_installed",
      "capabilities_not_dropped",
      "root_filesystem_writable",
    ])
      expect(smoke, reason).toContain(`assert_probe pr-agent ${reason}`);
    // A probe never prints a value of its environment.
    expect(smoke).toContain(
      "a value of the environment is in the probe verdict",
    );
  });

  // #324-T09
  it("compares the layers of the sandbox image with those of the dynamic image and looks for a Dispatcher", () => {
    expect(smoke).toContain(".RootFS.Layers");
    expect(smoke).toContain("/opt/code-reviewer/dispatcher");
    expect(smoke).toMatch(/sandbox mode needs the dynamic image/);
  });

  // #324-T06
  it("checks the engines file: owned by root, mode 600, on the /run tmpfs", () => {
    expect(smoke).toContain("/run/code-reviewer-engines.json");
    expect(smoke).toContain("0:0 600");
    expect(smoke).toMatch(/\/run .* - tmpfs /);
  });
});
