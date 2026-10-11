// SPDX-License-Identifier: Apache-2.0

// Pins down the structure of the nightly workflow (.github/workflows/nightly.yml): it runs the engine
// suite on a schedule through the shared engine workflow, read-only and without secrets. It reads the
// file as YAML; that GitHub triggers the schedule is not testable here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(`${repoRoot}.github/workflows/nightly.yml`, "utf8");

type Job = {
  if?: string;
  uses?: string;
  permissions?: Record<string, string>;
  steps?: unknown[];
};
type Workflow = {
  on: { schedule?: { cron?: string }[] } & Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const engine = workflow.jobs.engine as Job;

describe("nightly workflow", () => {
  // CR-41-T15
  it("runs on a schedule and on demand, and on nothing else", () => {
    expect(workflow.on.schedule?.length).toBe(1);
    expect(workflow.on.schedule?.[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Object.keys(workflow.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
  });

  // CR-41-T15
  it("runs the engine suite through the shared engine workflow", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["engine"]);
    expect(engine.uses).toBe("./.github/workflows/engine.yml");
    expect(engine.steps).toBeUndefined();
  });

  // CR-41-T15
  it("grants the token read access to the contents only and uses no secrets", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(engine.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/continue-on-error/);
  });

  // CR-41-T15
  it("does not run in forks", () => {
    expect(engine.if).toContain(
      "github.repository == 'ExpidetGames/code-reviewer'",
    );
  });
});
