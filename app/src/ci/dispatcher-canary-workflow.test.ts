// SPDX-License-Identifier: LicenseRef-Proprietary

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
    expect(job.environment).toBe("production");
    expect(source).not.toMatch(/id-token|packages:\s*write|contents:\s*write/);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
  });

  // #403-T05
  it("runs only from main, enforced in the job and not by a branch filter that a manual run ignores", () => {
    const condition = String(job.if);

    expect(condition).toContain("github.ref == 'refs/heads/main'");
    // Nothing else: no development, no tag, no pull request ref, no wildcard.
    expect(condition.match(/github\.ref\b/g)).toHaveLength(1);
    expect(condition).not.toMatch(
      /startsWith|contains\(github\.ref|development/,
    );
    // The ref is ANDed with the repository.
    expect(condition).toMatch(
      /repository == '[^']+' && github\.ref == 'refs\/heads\/main'( \}\})?$/,
    );
  });

  // #403-T03
  it("has no list of hosts any more: the platform decides which deployment may get the credential", () => {
    expect(source).not.toMatch(
      /DISPATCHER_CANARY_HOSTS|CANARY_ALLOWED_HOSTS|--check-only|vars\./,
    );
    expect(source).not.toContain("hosted-canary");
    const canary = stepNamed("Run the canary");
    expect(canary.run).toContain("--verify-vercel");
    expect(canary.run).toContain('--url "$CANARY_URL"');
  });

  // #403-T08
  it("lets two runs queue instead of cancelling one that is waiting for a canary VM", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency?.group).toBeTruthy();
  });

  // #403-T06
  it("loads the credentials from Infisical just before the canary step, after the dependencies were installed", () => {
    const names = job.steps.map((step) => step.name);
    const load = job.steps.find(
      (step) => step.uses === "./.github/actions/infisical-ci-secrets",
    );
    expect(load).toBeDefined();
    expect(load?.with?.["secret-names"]).toBe(
      "RUNNER_TOKEN VERCEL_TOKEN VERCEL_TEAM_ID VERCEL_DISPATCHER_PROJECT_ID VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET",
    );
    const at = job.steps.findIndex((step) => step === load);
    expect(at).toBeGreaterThan(names.indexOf("Install dependencies"));
    expect(at).toBeLessThan(names.indexOf("Run the canary"));
    // The checkout comes first: the action is a local one.
    expect(job.steps[0]?.uses).toMatch(/^actions\/checkout@/);
  });

  // #403-T06
  it("hands the canary step what it renames and reads the credentials from the environment, never in a command line", () => {
    const canary = stepNamed("Run the canary");
    expect(Object.keys(canary.env ?? {}).sort()).toEqual(
      [
        "CANARY_ENGINES",
        "CANARY_EXPECT_IMAGE_DIGEST",
        "CANARY_EXPECT_SNAPSHOT_ID",
        "CANARY_URL",
        "VERCEL_AUTOMATION_BYPASS_SECRET",
        "VERCEL_PROJECT_ID",
      ].sort(),
    );
    expect(canary.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_DISPATCHER_PROJECT_ID }}",
    );
    expect(canary.env?.VERCEL_AUTOMATION_BYPASS_SECRET).toBe(
      "${{ env.VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET }}",
    );
    expect(canary.env?.CANARY_EXPECT_IMAGE_DIGEST).toBe(
      "${{ inputs.image_digest }}",
    );
    // No step but the Infisical sign-in reads a secret.
    const withSecrets = job.steps.filter((step) =>
      JSON.stringify(step).includes("secrets."),
    );
    expect(withSecrets.map((step) => step.uses)).toEqual([
      "./.github/actions/infisical-ci-secrets",
    ]);
    expect(canary.run).not.toContain("secrets.");
    expect(canary.run).not.toMatch(
      /echo[^\n]*(RUNNER_TOKEN|BYPASS|VERCEL_TOKEN)/,
    );
    expect(canary.run).not.toMatch(/set -x|--debug|xtrace|--token/);
  });

  // #403-T01
  it("asks for a production deployment of the commit of this run and for the image the pipeline built", () => {
    const canary = stepNamed("Run the canary");
    expect(canary.run).toContain("--verify-vercel");
    expect(canary.run).toContain('--expect-commit "$GITHUB_SHA"');
    expect(workflow.on.workflow_call?.inputs).toHaveProperty("image_digest");
    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty(
      "image_digest",
    );
    // The commit is the one that was checked out, not a ref that can move.
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");
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
