// SPDX-License-Identifier: Apache-2.0

// Pins down the golden snapshot workflow (.github/workflows/golden-snapshot.yml, #330): it never runs for a pull
// request, only one job holds the platform secrets and only one step of it reads them, and the commit is
// archived and checked out without credentials. It reads the file as YAML; that the platform accepts the run is
// verified by the first real run (docs/golden-snapshot.md).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(
  `${repoRoot}.github/workflows/golden-snapshot.yml`,
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
  "runs-on"?: string;
};
type Workflow = {
  on: {
    push?: { branches?: string[] };
    workflow_dispatch?: { inputs?: Record<string, unknown> };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const jobs = Object.values(workflow.jobs);
const job = workflow.jobs.build as Job;

function stepNamed(name: string): Step {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`no step "${name}"`);
  return step;
}

describe("golden snapshot workflow", () => {
  // #330-extra-workflow
  it("runs on demand and on a push to main, and never for a pull request", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(source).not.toMatch(/pull_request/);
  });

  // #330-extra-workflow
  it("is opt-in on a push (a repository variable) and only for this repository", () => {
    const condition = String(job.if);
    expect(condition).toContain(
      "github.repository == 'ExpidetGames/code-reviewer'",
    );
    expect(condition).toContain("vars.GOLDEN_SNAPSHOT_ENABLED == 'true'");
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
  });

  // #403-T05
  it("runs only from main, so a manual run on another branch cannot use the Infisical sign-in of the environment production", () => {
    const condition = String(job.if);

    expect(condition).toContain("github.ref == 'refs/heads/main'");
    expect(condition).not.toContain("development");
    // The ref condition is ANDed with the others, not an alternative to them.
    expect(condition).toMatch(
      /repository == '[^']+' && github\.ref == 'refs\/heads\/main' && \(/,
    );
    expect(condition.match(/github\.ref ==/g)).toHaveLength(1);
  });

  // #330-extra-workflow
  it("has one job, read-only for the repository, in a protected environment, with no OIDC or write permission", () => {
    expect(jobs).toHaveLength(1);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("production");
    expect(source).not.toMatch(/id-token|packages:\s*write|contents:\s*write/);
  });

  // #330-extra-workflow
  it("lets two runs queue instead of cancelling one that is building a snapshot", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency?.group).toBeTruthy();
  });

  // #403-T06
  it("loads the platform credentials from Infisical after the install and just before the build step, which alone uses them", () => {
    const names = job.steps.map((step) => step.name);
    const load = job.steps.find(
      (step) => step.uses === "./.github/actions/infisical-ci-secrets",
    );
    expect(load?.with?.["secret-names"]).toBe(
      "VERCEL_TOKEN VERCEL_TEAM_ID VERCEL_DISPATCHER_PROJECT_ID",
    );
    const at = job.steps.findIndex((step) => step === load);
    expect(at).toBeGreaterThan(names.indexOf("Install dependencies"));
    expect(at).toBeLessThan(
      names.indexOf("Build, check and record the snapshot"),
    );
    expect(job.steps[0]?.uses).toMatch(/^actions\/checkout@/);
    // Only the Infisical sign-in reads a secret of GitHub.
    const withSecrets = job.steps.filter((step) =>
      JSON.stringify(step).includes("secrets."),
    );
    expect(withSecrets).toEqual([load]);
  });

  // #403-T06
  it("hands the build step the project id under the name the client reads, and no credential in a command line", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(Object.keys(build.env ?? {}).sort()).toEqual([
      "PINNED",
      "TARGET",
      "VERCEL_PROJECT_ID",
    ]);
    expect(build.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_DISPATCHER_PROJECT_ID }}",
    );
    expect(build.run).not.toContain("secrets.");
    expect(build.run).not.toMatch(/echo[^\n]*VERCEL_/);
    expect(build.run).not.toMatch(/set -x|--debug|xtrace/);
  });

  // #330-T02
  it("passes the dispatch inputs through environment variables, not into the shell text", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(build.env?.TARGET).toContain("inputs.target");
    expect(build.env?.PINNED).toContain("inputs.pinned_snapshot");
    for (const step of job.steps)
      expect(step.run ?? "", step.name).not.toMatch(/\$\{\{\s*inputs\./);
  });

  // #330-extra-workflow
  it("checks the commit out without credentials, installs from the lockfile and archives the commit", () => {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(stepNamed("Install dependencies").run).toBe(
      "pnpm install --frozen-lockfile",
    );
    expect(stepNamed("Install dependencies")["working-directory"]).toBe(
      "dispatcher",
    );
    expect(stepNamed("Archive the commit").run).toContain("git archive");
  });

  // #330-extra-workflow
  it("builds from the archive with the vm-prepare script of the commit and keeps the record as an artifact", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(build["working-directory"]).toBe("dispatcher");
    expect(build.run).toContain("pnpm snapshot:build");
    expect(build.run).toContain("--vm-prepare ../docker/sandbox/vm-prepare.sh");
    expect(build.run).toContain('--commit "$GITHUB_SHA"');
    const upload = job.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload).toBeDefined();
    expect(String(upload?.with?.path)).toContain("golden-snapshot.json");
  });

  // #330-extra-workflow
  it("passes a vm-prepare script that exists in the repository (the one #325 owns)", () => {
    const build = stepNamed("Build, check and record the snapshot");
    const path = /--vm-prepare \.\.\/(\S+)/.exec(build.run ?? "")?.[1];
    expect(path).toBe("docker/sandbox/vm-prepare.sh");
    expect(existsSync(`${repoRoot}${path}`)).toBe(true);
  });

  // #330-extra-workflow
  it("does not ignore a failure of any step", () => {
    for (const step of job.steps)
      expect(step["continue-on-error"], step.name).toBeUndefined();
  });
});
