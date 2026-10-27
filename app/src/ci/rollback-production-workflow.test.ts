// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the manual rollback of the hosted deployment (.github/workflows/rollback-production.yml, #403): it runs
// on demand from main only, in a queue of its own, takes the deployment to restore per project, checks with the
// Vercel API that it is a ready production deployment of that project, puts exactly that deployment back into
// production with the pinned Vercel CLI, and writes the restored Dispatcher's snapshot pair back to Infisical.
import { describe, expect, it } from "vitest";
import { runStep } from "./shell-support.ts";
import {
  isInfisicalLoad,
  readText,
  readWorkflow,
  stepIndex,
  stepsOf,
  type Job,
  REPOSITORY,
} from "./workflow-support.ts";

const source = readText(".github/workflows/rollback-production.yml");
const workflow = readWorkflow("rollback-production.yml");
const job = Object.values(workflow.jobs)[0] as Job;
const steps = stepsOf(job);
const named = (name: string) => {
  const step = steps.find((s) => s.name === name);
  if (!step) throw new Error(`no step "${name}"`);
  return step;
};

describe("the production rollback workflow", () => {
  // #403-T09
  it("runs on demand and for nothing else", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(source).not.toMatch(/pull_request|push:|schedule:|workflow_call/);
    const inputs = (
      workflow.on.workflow_dispatch as { inputs: Record<string, unknown> }
    ).inputs;
    expect(Object.keys(inputs).sort()).toEqual([
      "app_deployment",
      "dispatcher_deployment",
    ]);
  });

  // #403-T09
  it("has one job, for this repository and the main branch only, in the environment production", () => {
    expect(Object.keys(workflow.jobs)).toHaveLength(1);
    const condition = String(job.if);
    expect(condition).toContain(`github.repository == '${REPOSITORY}'`);
    expect(condition).toContain("github.ref == 'refs/heads/main'");
    expect(condition.match(/github\.ref\b/g)).toHaveLength(1);
    expect(job.environment).toBe("production");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(
      /id-token|contents:\s*write|deployments:\s*write/,
    );
  });

  // #403-T20
  it("has a queue of its own: an emergency rollback does not wait behind a deployment, and neither drops the other", () => {
    expect(workflow.concurrency).toEqual({
      group: "rollback-production",
      "cancel-in-progress": false,
    });
    expect(readWorkflow("deploy-production.yml").concurrency?.group).not.toBe(
      workflow.concurrency?.group,
    );
  });

  // #403-T09
  it("installs the dependencies before the token is loaded, and the CLI from the lockfile", () => {
    const install = steps.findIndex((s) =>
      /pnpm install --frozen-lockfile --filter code-reviewer-dispatcher\.\.\./.test(
        s.run ?? "",
      ),
    );
    const load = stepIndex(job, isInfisicalLoad);
    const cli = steps.findIndex(
      (s) => s.uses === "./.github/actions/vercel-cli",
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(cli).toBeGreaterThanOrEqual(0);
    expect(load).toBeGreaterThan(install);
    expect(load).toBeGreaterThan(cli);
    expect(source).not.toMatch(/(?<!p)npm install|VERCEL_CLI_VERSION/);
  });

  // #403-T09
  it("verifies both deployments against the Vercel API before it rolls either back", () => {
    const apps = named(
      "Check that the App deployment is a production deployment of the App",
    );
    const dispatchers = named(
      "Check that the Dispatcher deployment is a production deployment of the Dispatcher",
    );
    expect(apps.run).toBe(
      'pnpm --dir dispatcher snapshot:ops verify --deployment "$DEPLOYMENT"',
    );
    expect(apps.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_APP_PROJECT_ID }}",
    );
    expect(dispatchers.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_DISPATCHER_PROJECT_ID }}",
    );
    const firstRollback = steps.findIndex((s) =>
      /vercel rollback/.test(s.run ?? ""),
    );
    expect(steps.indexOf(apps)).toBeLessThan(firstRollback);
    expect(steps.indexOf(dispatchers)).toBeLessThan(firstRollback);
    expect(apps.if).toContain("inputs.app_deployment != ''");
    expect(dispatchers.if).toContain("inputs.dispatcher_deployment != ''");
  });

  // #403-T09
  it("restores each given deployment with the pinned CLI in its own project, and only that", () => {
    const rollbacks = steps.filter((step) =>
      /vercel rollback/.test(step.run ?? ""),
    );
    expect(rollbacks).toHaveLength(2);
    expect(rollbacks[0]?.run).toContain('vercel rollback "$DEPLOYMENT"');
    expect(rollbacks[0]?.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_APP_PROJECT_ID }}",
    );
    expect(rollbacks[1]?.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_DISPATCHER_PROJECT_ID }}",
    );
    for (const step of rollbacks) {
      expect(step.if).toBeTruthy();
      expect(step.env?.VERCEL_ORG_ID).toBe("${{ env.VERCEL_TEAM_ID }}");
    }
    for (const step of steps)
      expect(step["continue-on-error"], step.name).toBeUndefined();
  });

  // #403-T19
  it("writes the restored Dispatcher's snapshot pair back to Infisical, from that deployment's meta, after the rollback", () => {
    const write = named(
      "Write the restored Dispatcher's golden snapshot pair back to Infisical",
    );
    expect(write.uses).toBe("./.github/actions/infisical-write-snapshot-pair");
    expect(write.if).toContain("inputs.dispatcher_deployment != ''");
    expect(write.with?.["from-deployment"]).toBe(
      "${{ inputs.dispatcher_deployment }}",
    );
    expect(write.with?.["vercel-project-id"]).toBe(
      "${{ env.VERCEL_DISPATCHER_PROJECT_ID }}",
    );
    expect(steps.indexOf(write)).toBeGreaterThan(
      steps.findIndex(
        (s) =>
          /vercel rollback/.test(s.run ?? "") && s.name?.includes("Dispatcher"),
      ),
    );
  });

  // #403-T09
  it("passes the inputs to the shell as environment variables only", () => {
    for (const step of steps)
      expect(step.run ?? "", step.name).not.toContain("${{");
    expect(named("Check the inputs").env?.APP_DEPLOYMENT).toBe(
      "${{ inputs.app_deployment }}",
    );
    expect(named("Check the inputs").env?.DISPATCHER_DEPLOYMENT).toBe(
      "${{ inputs.dispatcher_deployment }}",
    );
  });
});

describe("the input check of the rollback", () => {
  const selector = {
    workflow: "rollback-production.yml",
    job: "rollback",
    step: "Check the inputs",
  } as const;

  // #403-T09
  it.each([
    ["an id", { APP_DEPLOYMENT: "dpl_example0001", DISPATCHER_DEPLOYMENT: "" }],
    [
      "an address",
      {
        APP_DEPLOYMENT: "",
        DISPATCHER_DEPLOYMENT: "https://example-abc.vercel.app",
      },
    ],
    [
      "both",
      {
        APP_DEPLOYMENT: "dpl_example0001",
        DISPATCHER_DEPLOYMENT: "https://example-abc.vercel.app",
      },
    ],
  ])("accepts %s", (_name, env) => {
    expect(runStep(selector, { env }).status).toBe(0);
  });

  // #403-T09
  it.each([
    ["nothing", { APP_DEPLOYMENT: "", DISPATCHER_DEPLOYMENT: "" }],
    [
      "an address on another host",
      { APP_DEPLOYMENT: "https://example.com", DISPATCHER_DEPLOYMENT: "" },
    ],
    [
      "a path",
      {
        APP_DEPLOYMENT: "https://example-abc.vercel.app/x",
        DISPATCHER_DEPLOYMENT: "",
      },
    ],
    ["a flag", { APP_DEPLOYMENT: "--yes", DISPATCHER_DEPLOYMENT: "" }],
    ["a short id", { APP_DEPLOYMENT: "dpl_x", DISPATCHER_DEPLOYMENT: "" }],
    [
      "a second value that is wrong",
      { APP_DEPLOYMENT: "dpl_example0001", DISPATCHER_DEPLOYMENT: "latest" },
    ],
  ])("refuses %s", (_name, env) => {
    const run = runStep(selector, { env });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error::");
  });
});
