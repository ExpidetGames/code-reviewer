// SPDX-License-Identifier: Apache-2.0

// Pins down how CI proves the privileged lane of the Sandbox-Launcher (#329-T09, T10): a job of its own runs
// `make test-sandbox-local` on the runner's Docker daemon, which builds the `sandbox` target and runs the Launcher's
// local mode against it and the fake App, so `docker run <image id>` with the full rendered flag set meets a real
// daemon. Docker itself runs in CI; here the wiring is judged.
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

function job(id: string): Job {
  const found = ci.jobs[id];
  if (!found) throw new Error(`ci.yml has no job "${id}"`);
  return found;
}

describe("the CI job of the Sandbox-Launcher's privileged lane", () => {
  const lane = () => job("sandbox-local");
  const commands = () =>
    (lane().steps ?? []).flatMap((step) =>
      (step.run ?? "").split("\n").map((line) => line.trim()),
    );

  // #329-T09
  it("installs the Dispatcher from its lockfile and runs make test-sandbox-local, after the install", () => {
    const lines = commands();

    expect(lines).toContain("pnpm --dir dispatcher install --frozen-lockfile");
    expect(lines).toContain("make test-sandbox-local");
    expect(
      lines.indexOf("pnpm --dir dispatcher install --frozen-lockfile"),
    ).toBeLessThan(lines.indexOf("make test-sandbox-local"));
    expect(
      (lane().steps ?? []).find((step) =>
        step.uses?.startsWith("pnpm/action-setup@"),
      )?.with?.package_json_file,
    ).toBe("dispatcher/package.json");
    expect(
      (lane().steps ?? []).find((step) =>
        step.uses?.startsWith("actions/setup-node@"),
      )?.with,
    ).toMatchObject({ "node-version-file": ".nvmrc" });
  });

  // #329-T09
  it("runs for pull requests that change the Dispatcher or the Worker image, and every pull request into main", () => {
    const condition = String(lane().if);

    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.dispatcher == 'true'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
    expect(lane().needs).toBe("changes");
  });

  // #329-T09
  it("has no more rights than the image jobs, no registry login and a timeout for the image build", () => {
    expect(lane().permissions).toBeUndefined();
    expect(JSON.stringify(lane())).not.toMatch(
      /docker\s+(push|login)|login-action/,
    );
    expect(lane()["timeout-minutes"]).toBeGreaterThanOrEqual(20);
  });

  // #329-T09
  it("is part of the aggregate check, so a red lane blocks the merge", () => {
    expect(job("ci-passed").needs).toContain("sandbox-local");
  });

  // #329-T09
  it("is a make target that builds the sandbox target, names the image and allows the gateway to the test's network guard", () => {
    const makefile = read("Makefile");
    const recipe = makefile.slice(makefile.indexOf("\ntest-sandbox-local:"));

    expect(recipe).toContain(
      "--target sandbox --tag code-reviewer-worker:local",
    );
    expect(recipe).toContain("SANDBOX_LOCAL_IMAGE=code-reviewer-worker:local");
    expect(recipe).toContain("TEST_ALLOWED_HOSTS=");
    expect(recipe).toContain("test:privileged");
  });
});
