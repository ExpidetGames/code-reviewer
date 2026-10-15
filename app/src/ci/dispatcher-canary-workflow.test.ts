// SPDX-License-Identifier: Apache-2.0

// Pins down the deploy canary workflow (.github/workflows/dispatcher-canary.yml, #331): it calls `POST /probe` of a
// deployed Dispatcher and fails when the Dynamic canary does not pass, so a release pipeline can gate on it. It never
// runs for a pull request, only one step reads the credential and the URL never reaches the shell text. It reads
// the file as YAML; that the platform accepts a run is verified by the first real one (dispatcher/README.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(
  `${repoRoot}.github/workflows/dispatcher-canary.yml`,
  "utf8",
);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
} & Record<string, unknown>;
type Job = {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  "timeout-minutes"?: number;
};
type Workflow = {
  on: {
    workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> };
    workflow_call?: { inputs?: Record<string, { required?: boolean }> };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const job = workflow.jobs.canary as Job;

function stepNamed(name: string): Step {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`no step "${name}"`);
  return step;
}

describe("dispatcher canary workflow", () => {
  // #331-extra-workflow
  it("runs on demand and when a release workflow calls it, and never for a pull request", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(workflow.on.workflow_dispatch?.inputs?.url?.required).toBe(true);
    expect(workflow.on.workflow_call?.inputs?.url?.required).toBe(true);
    expect(source).not.toMatch(/pull_request|push:/);
  });

  // #331-extra-workflow
  it("has one job, read-only for the repository, for this repository only, in a protected environment", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["canary"]);
    expect(String(job.if)).toContain(
      "github.repository == 'ExpidetGames/code-reviewer'",
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("hosted-canary");
    expect(source).not.toMatch(/id-token|packages:\s*write|contents:\s*write/);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
  });

  // #331-extra-workflow
  it("lets two runs queue instead of cancelling one that is waiting for a canary VM", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency?.group).toBeTruthy();
  });

  // #331-T05
  it("reads the dispatcher credential in the canary step only, as environment, never in a command line", () => {
    const withSecrets = job.steps.filter((step) =>
      JSON.stringify(step).includes("secrets."),
    );
    expect(withSecrets.map((step) => step.name)).toEqual([
      "Run the canary",
    ]);
    const canary = withSecrets[0] as Step;
    expect(Object.keys(canary.env ?? {}).sort()).toEqual(
      [
        "CANARY_ENGINES",
        "CANARY_URL",
        "RUNNER_TOKEN",
        "VERCEL_AUTOMATION_BYPASS_SECRET",
      ].sort(),
    );
    expect(canary.run).not.toContain("secrets.");
    expect(canary.run).not.toMatch(/echo[^\n]*(RUNNER_TOKEN|BYPASS)/);
    expect(canary.run).not.toMatch(/set -x|--debug|xtrace|--token/);
  });

  // #331-extra-workflow
  it("passes the inputs through environment variables, not into the shell text", () => {
    const canary = stepNamed("Run the canary");
    expect(canary.env?.CANARY_URL).toContain("inputs.url");
    expect(canary.env?.CANARY_ENGINES).toContain("inputs.engines");
    for (const step of job.steps)
      expect(step.run ?? "", step.name).not.toMatch(/\$\{\{\s*inputs\./);
  });

  // #331-extra-workflow
  it("checks out without credentials, installs from the lockfile and runs the canary command", () => {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(stepNamed("Install dependencies").run).toBe(
      "pnpm install --frozen-lockfile",
    );
    const canary = stepNamed("Run the canary");
    expect(canary["working-directory"]).toBe("dispatcher");
    expect(canary.run).toContain("pnpm probe:canary");
    expect(canary.run).toContain('--url "$CANARY_URL"');
    expect(canary.run).toContain('--engines "$CANARY_ENGINES"');
  });

  // #331-extra-workflow
  it("does not ignore a failure of any step", () => {
    for (const step of job.steps)
      expect(step["continue-on-error"], step.name).toBeUndefined();
  });
});
