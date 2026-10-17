// SPDX-License-Identifier: Apache-2.0

// Pins down the manual rollback of the hosted deployment (.github/workflows/rollback-production.yml, #403): it
// runs on demand from main only, takes the deployment to restore per project and puts exactly that deployment back
// into production with the pinned Vercel CLI.
import { describe, expect, it } from "vitest";
import {
  isInfisicalLoad,
  readText,
  readWorkflow,
  stepIndex,
  stepsOf,
  type Job,
} from "./workflow-support.ts";

const source = readText(".github/workflows/rollback-production.yml");
const workflow = readWorkflow("rollback-production.yml");
const job = Object.values(workflow.jobs)[0] as Job;

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
    expect(condition).toContain(
      "github.repository == 'ExpidetGames/code-reviewer'",
    );
    expect(condition).toContain("github.ref == 'refs/heads/main'");
    expect(condition.match(/github\.ref\b/g)).toHaveLength(1);
    expect(job.environment).toBe("production");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(
      /id-token|contents:\s*write|deployments:\s*write/,
    );
  });

  // #403-T08
  it("queues behind a running deployment instead of racing it", () => {
    expect(workflow.concurrency).toEqual({
      group: "deploy-production",
      "cancel-in-progress": false,
    });
  });

  // #403-T09
  it("checks both inputs for the shape of a deployment id or address before it signs in, and passes them as environment variables", () => {
    const steps = stepsOf(job);
    const check = steps.findIndex((step) => (step.run ?? "").includes("dpl_"));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(stepIndex(job, isInfisicalLoad));
    expect(steps[check]?.env?.APP_DEPLOYMENT).toBe(
      "${{ inputs.app_deployment }}",
    );
    expect(steps[check]?.env?.DISPATCHER_DEPLOYMENT).toBe(
      "${{ inputs.dispatcher_deployment }}",
    );
    expect(steps[check]?.run).toContain("https://[a-z0-9-]+\\.vercel\\.app");
    // Nothing to do is a mistake, not a success.
    expect(steps[check]?.run).toMatch(/at least one/);
    for (const step of steps)
      expect(step.run ?? "", step.name).not.toContain("${{");
  });

  // #403-T09
  it("restores each given deployment with the pinned CLI in its own project, and only that", () => {
    const steps = stepsOf(job);
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
    expect(workflow.env?.VERCEL_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(source).toContain(
      'npm install --global "vercel@${VERCEL_CLI_VERSION}"',
    );
    const load = stepIndex(job, isInfisicalLoad);
    expect(
      steps.findIndex((step) => /vercel rollback/.test(step.run ?? "")),
    ).toBeGreaterThan(load);
    for (const step of steps)
      expect(step["continue-on-error"], step.name).toBeUndefined();
  });
});
