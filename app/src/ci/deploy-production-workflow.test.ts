// SPDX-License-Identifier: Apache-2.0

// Pins down the production deployment of the hosted version (#403): .github/workflows/deploy-production.yml
// migrates the database, stages the App and then the Dispatcher with the Vercel CLI (a staged deployment takes no
// domain), checks the App's health, runs the Dispatcher canary on the staged Dispatcher and only then promotes
// both. A failure of any job leaves production on the old deployments. It reads the files as YAML; that the
// platform accepts the run is verified by the first real one (docs/deployment-vercel.md, section 9).
import { describe, expect, it } from "vitest";
import {
  isInfisicalLoad,
  needsOf,
  readText,
  readWorkflow,
  runsVercel,
  stepIndex,
  stepsOf,
  type Job,
} from "./workflow-support.ts";

const source = readText(".github/workflows/deploy-production.yml");
const workflow = readWorkflow("deploy-production.yml");
const stageSource = readText(".github/workflows/vercel-stage.yml");
const stage = readWorkflow("vercel-stage.yml");
const stageJob = stage.jobs.stage as Job;
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`no job "${name}"`);
  return found;
};
const REPOSITORY_GUARD = "github.repository == 'ExpidetGames/code-reviewer'";
const MAIN_GUARD = "github.ref == 'refs/heads/main'";

describe("the production deployment workflow", () => {
  // #403-T05
  it("runs for a push to main and on demand, and for nothing else", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect((workflow.on.push as { branches?: string[] }).branches).toEqual([
      "main",
    ]);
  });

  // #403-T08
  it("lets deployments queue one behind the other and never cancels one in progress", () => {
    expect(workflow.concurrency).toEqual({
      group: "deploy-production",
      "cancel-in-progress": false,
    });
    for (const name of Object.keys(workflow.jobs))
      expect(job(name).concurrency, name).toBeUndefined();
  });

  // #403-T07
  it("runs migrate, the App, the Dispatcher, the health check, the canary and promote in that order", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "migrate",
      "stage-app",
      "stage-dispatcher",
      "health-app",
      "canary",
      "promote",
      "record",
    ]);
    expect(needsOf(job("migrate"))).toEqual([]);
    expect(needsOf(job("stage-app"))).toEqual(["migrate"]);
    expect(needsOf(job("stage-dispatcher"))).toEqual(["stage-app"]);
    expect(needsOf(job("health-app"))).toEqual(["stage-app"]);
    expect(needsOf(job("canary")).sort()).toEqual([
      "health-app",
      "stage-dispatcher",
    ]);
  });

  // #403-T07
  it("promotes only after both deployments were staged, the App is healthy and the canary passed", () => {
    const needs = needsOf(job("promote"));
    for (const name of [
      "stage-app",
      "stage-dispatcher",
      "health-app",
      "canary",
    ])
      expect(needs).toContain(name);
    // No job after the canary can ever promote, and nothing is allowed to run when a need failed.
    for (const name of [
      "promote",
      "canary",
      "health-app",
      "stage-app",
      "stage-dispatcher",
    ])
      expect(String(job(name).if), name).not.toMatch(
        /always\(\)|failure\(\)|cancelled\(\)|success\(\)/,
      );
  });

  // #403-T05
  it("guards every job with the repository and the main branch, in the job and not in a branch filter", () => {
    for (const [name, found] of Object.entries(workflow.jobs)) {
      const condition = String(found.if);
      expect(condition, name).toContain(REPOSITORY_GUARD);
      expect(condition, name).toContain(MAIN_GUARD);
      expect(condition.match(/github\.ref\b/g), name).toHaveLength(1);
      expect(condition, name).not.toMatch(/startsWith|contains\(github\.ref/);
    }
    // The reusable workflow carries the same guard, so that it cannot be started from anywhere else.
    const guard = String(stageJob.if);
    expect(guard).toContain(REPOSITORY_GUARD);
    expect(guard).toContain(MAIN_GUARD);
    expect(Object.keys(stage.on)).toEqual(["workflow_call"]);
  });

  // #403-T05
  it("holds nothing but read access to the repository, and writes deployments only where it records them", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/id-token|packages:\s*write|contents:\s*write/);
    const writers = Object.entries(workflow.jobs)
      .filter(([, found]) => found.permissions?.deployments === "write")
      .map(([name]) => name);
    expect(writers.sort()).toEqual(["record", "stage-app", "stage-dispatcher"]);
    for (const found of [...Object.values(workflow.jobs), stageJob])
      expect(found.permissions?.contents, found.name).toBe("read");
  });

  // #403-T06
  it("runs every job that signs in to Infisical in the environment production", () => {
    for (const name of ["migrate", "health-app", "promote"])
      expect(job(name).environment, name).toBe("production");
    expect(stageJob.environment).toBe("production");
    expect(readWorkflow("dispatcher-canary.yml").jobs.canary?.environment).toBe(
      "production",
    );
    expect(source).not.toMatch(/secrets: inherit/);
  });

  // #403-T07
  it("migrates the database first with the migrate role's URL from Infisical, before anything is deployed", () => {
    const migrate = job("migrate");
    const load = stepIndex(migrate, isInfisicalLoad);
    const run = stepIndex(migrate, (step) =>
      (step.run ?? "").includes("pnpm --dir app migrate"),
    );
    const install = stepIndex(migrate, (step) =>
      (step.run ?? "").includes("pnpm --dir app install --frozen-lockfile"),
    );
    expect(install).toBeGreaterThanOrEqual(0);
    // The credential is loaded after the dependencies were installed and just before the command that uses it.
    expect(load).toBeGreaterThan(install);
    expect(run).toBeGreaterThan(load);
    expect(stepsOf(migrate)[load]?.with?.["secret-names"]).toBe(
      "DATABASE_URL_MIGRATE",
    );
    expect(JSON.stringify(stepsOf(migrate)[run])).not.toContain("secrets.");
    expect(source).not.toMatch(/\bDATABASE_URL:/);
  });

  // #403-T08
  it("stages the App and then the Dispatcher with the same reusable workflow, each from the commit that triggered the run", () => {
    for (const [name, directory, project] of [
      ["stage-app", "app", "VERCEL_APP_PROJECT_ID"],
      ["stage-dispatcher", "dispatcher", "VERCEL_DISPATCHER_PROJECT_ID"],
    ] as const) {
      const found = job(name);
      expect(found.uses).toBe("./.github/workflows/vercel-stage.yml");
      expect(found.with).toMatchObject({
        project: name === "stage-app" ? "app" : "dispatcher",
        directory,
        "project-id-secret": project,
        ref: "${{ github.sha }}",
      });
      expect(found.secrets).toBeUndefined();
    }
  });

  // #403-T08
  it("pins the Vercel CLI to an exact version in every workflow that installs it", () => {
    for (const file of [
      "vercel-stage.yml",
      "deploy-production.yml",
      "rollback-production.yml",
    ]) {
      const parsed = readWorkflow(file);
      expect(parsed.env?.VERCEL_CLI_VERSION, file).toMatch(/^\d+\.\d+\.\d+$/);
      const text = readText(`.github/workflows/${file}`);
      expect(text, file).toContain(
        'npm install --global "vercel@${VERCEL_CLI_VERSION}"',
      );
      expect(text, file).not.toMatch(/vercel@(latest|next|canary)/);
    }
    // One version everywhere.
    const versions = new Set(
      [
        "vercel-stage.yml",
        "deploy-production.yml",
        "rollback-production.yml",
      ].map((file) => readWorkflow(file).env?.VERCEL_CLI_VERSION),
    );
    expect(versions.size).toBe(1);
  });

  // #403-T08
  it("pulls, builds and deploys prebuilt, staged without a domain, and loads the credentials just before the first CLI step", () => {
    const steps = stepsOf(stageJob);
    const at = (command: string) =>
      steps.findIndex((step) => runsVercel(step, command));
    const load = stepIndex(stageJob, isInfisicalLoad);
    const install = stepIndex(stageJob, (step) =>
      (step.run ?? "").includes("npm install --global"),
    );
    const pnpm = stepIndex(
      stageJob,
      (step) => step.uses?.startsWith("pnpm/action-setup@") ?? false,
    );
    expect(pnpm).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(pnpm);
    expect(load).toBeGreaterThan(install);
    expect(at("pull")).toBeGreaterThan(load);
    expect(at("build")).toBeGreaterThan(at("pull"));
    expect(at("deploy")).toBeGreaterThan(at("build"));
    expect(steps[at("pull")]?.run).toContain(
      "vercel pull --yes --environment=production",
    );
    expect(steps[at("build")]?.run).toContain("vercel build --prod");
    const deploy = steps[at("deploy")]?.run ?? "";
    expect(deploy).toContain("vercel deploy --prebuilt --prod --skip-domain");
    // The project's Git integration is off, so the CLI deploys what was built here.
    expect(deploy).not.toContain("--force");
    // Nothing before the load step runs the CLI or sees the token.
    expect(
      steps.slice(0, load).some((step) => (step.run ?? "").includes("vercel ")),
    ).toBe(false);
  });

  // #403-T07
  it("captures the staged URL from the CLI's output and refuses anything that is not a Vercel deployment address", () => {
    const deploy = stepsOf(stageJob).find((step) => runsVercel(step, "deploy"));
    expect(deploy?.id).toBe("deploy");
    expect(deploy?.run).toContain('>> "$GITHUB_OUTPUT"');
    expect(deploy?.run).toContain("https://[a-z0-9-]+\\.vercel\\.app");
    expect(stageJob.outputs?.url).toBe("${{ steps.deploy.outputs.url }}");
    // The credentials are environment variables the CLI reads: the CLI never gets them as arguments.
    expect(stageSource).not.toMatch(/vercel [^\n]*--token/);
    const exportStep = stepsOf(stageJob).find((step) =>
      (step.run ?? "").includes("VERCEL_ORG_ID"),
    );
    expect(exportStep?.run).toContain("VERCEL_ORG_ID=${VERCEL_TEAM_ID}");
  });

  // #403-T07
  it("checks the staged App's health: 200 and status ok, SCHEMA_BEHIND and every other failure block, the bypass secret goes in a header file", () => {
    const health = job("health-app");
    const load = stepIndex(health, isInfisicalLoad);
    const check = stepIndex(health, (step) =>
      (step.run ?? "").includes("/api/health"),
    );
    expect(load).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(load);
    expect(stepsOf(health)[load]?.with?.["secret-names"]).toBe(
      "VERCEL_APP_AUTOMATION_BYPASS_SECRET",
    );
    const step = stepsOf(health)[check];
    expect(step?.env?.DEPLOYMENT_URL).toBe(
      "${{ needs.stage-app.outputs.url }}",
    );
    const run = step?.run ?? "";
    expect(run).toContain("SCHEMA_BEHIND");
    expect(run).toContain('.status == "ok"');
    expect(run).toContain("x-vercel-protection-bypass");
    // A header file, not an argument: an argument shows in the process list.
    expect(run).toMatch(/--header @/);
    expect(run).not.toMatch(/--header "x-vercel-protection-bypass/);
    // No redirect is followed, and the secret only goes to a Vercel deployment address.
    expect(run).not.toMatch(/--location|\scurl [^\n]*-L\b/);
    expect(run).toContain("https://[a-z0-9-]+\\.vercel\\.app");
    expect(run).not.toMatch(/set \+e|\|\| true\n\s*(exit 0)/);
  });

  // #403-T07
  it("runs the canary workflow on the staged Dispatcher, and nothing else is passed to it", () => {
    const canary = job("canary");
    expect(canary.uses).toBe("./.github/workflows/dispatcher-canary.yml");
    expect(canary.with?.url).toBe("${{ needs.stage-dispatcher.outputs.url }}");
    expect(Object.keys(canary.with ?? {}).sort()).toEqual(["engines", "url"]);
    expect(canary.secrets).toBeUndefined();
  });

  // #403-T07
  it("promotes the App and then the Dispatcher with the pinned CLI, each in its own project, and no step skips a failure", () => {
    const promote = job("promote");
    const steps = stepsOf(promote);
    const load = stepIndex(promote, isInfisicalLoad);
    const app = steps.findIndex(
      (step) =>
        runsVercel(step, "promote") &&
        step.env?.DEPLOYMENT_URL?.includes("stage-app"),
    );
    const dispatcher = steps.findIndex(
      (step) =>
        runsVercel(step, "promote") &&
        step.env?.DEPLOYMENT_URL?.includes("stage-dispatcher"),
    );
    expect(load).toBeGreaterThanOrEqual(0);
    expect(app).toBeGreaterThan(load);
    expect(dispatcher).toBeGreaterThan(app);
    expect(steps[app]?.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_APP_PROJECT_ID }}",
    );
    expect(steps[dispatcher]?.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_DISPATCHER_PROJECT_ID }}",
    );
    for (const index of [app, dispatcher]) {
      expect(steps[index]?.env?.VERCEL_ORG_ID).toBe(
        "${{ env.VERCEL_TEAM_ID }}",
      );
      expect(steps[index]?.run).toContain('vercel promote "$DEPLOYMENT_URL"');
    }
    for (const found of [...Object.values(workflow.jobs), stageJob])
      for (const step of stepsOf(found))
        expect(step["continue-on-error"], step.name).toBeUndefined();
  });

  // #403-T08
  it("records the deployments on GitHub, and marks them failed when the pipeline did not reach production", () => {
    const record = job("record");
    expect(needsOf(record).sort()).toEqual([
      "promote",
      "stage-app",
      "stage-dispatcher",
    ]);
    expect(String(record.if)).toContain("always()");
    expect(String(record.if)).toContain(REPOSITORY_GUARD);
    expect(String(record.if)).toContain(MAIN_GUARD);
    const script = stepsOf(record).find((step) =>
      step.uses?.startsWith("actions/github-script@"),
    );
    expect(script?.env?.PROMOTE_RESULT).toBe("${{ needs.promote.result }}");
    expect(String(script?.with?.script)).toContain("createDeploymentStatus");
    const create = stepsOf(stageJob).filter((step) =>
      step.uses?.startsWith("actions/github-script@"),
    );
    expect(
      create.some((step) =>
        String(step.with?.script).includes("createDeployment("),
      ),
    ).toBe(true);
    expect(stageJob.outputs?.["deployment-id"]).toBeTruthy();
  });

  // #403-T05
  it("checks out the commit that triggered the run, without credentials", () => {
    for (const found of [...Object.values(workflow.jobs), stageJob]) {
      const checkout = stepsOf(found).find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      if (checkout === undefined) continue;
      expect(checkout.with?.["persist-credentials"]).toBe(false);
      expect(String(checkout.with?.ref)).toMatch(/github\.sha|inputs\.ref/);
    }
  });

  // #403-T08
  it("passes values to the shell as environment variables only", () => {
    for (const found of [...Object.values(workflow.jobs), stageJob])
      for (const step of stepsOf(found))
        expect(step.run ?? "", step.name).not.toContain("${{");
  });
});
