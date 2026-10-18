// SPDX-License-Identifier: Apache-2.0

// Pins down which jobs of .github/workflows/deploy-production.yml run in which case (#480). A run that reuses the
// golden snapshot skips `snapshot-build`, and a job without a status function in its `if` is skipped with it, however
// many jobs sit between them: run 39156075409 staged both deployments, passed the health check and the canary, and
// promoted nothing. The conditions are evaluated by workflow-conditions.ts, not matched as text.
import { describe, expect, it } from "vitest";
import {
  dependentsOf,
  hasStatusFunction,
  simulate,
  type Scenario,
} from "./workflow-conditions.ts";
import { needsOf, readWorkflow, type Job } from "./workflow-support.ts";

const workflow = readWorkflow("deploy-production.yml");
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`no job "${name}"`);
  return found;
};
const PROMOTIONS = ["promote-app", "promote-dispatcher"];

/** The snapshot is reused: the decision says no rebuild, so `snapshot-build` is skipped. */
const reuse: Scenario = {
  outputs: { "snapshot-decide": { rebuild: "false", repair: "false" } },
};
const rebuild: Scenario = {
  outputs: { "snapshot-decide": { rebuild: "true", repair: "false" } },
};

describe("the model of the conditions", () => {
  // #480-T01
  it("skips a job without a status function when a job further up the chain was skipped, even though its own need ran", () => {
    const result = simulate(
      {
        on: {},
        jobs: {
          skipped: { if: "${{ 'a' == 'b' }}" },
          middle: { needs: "skipped", if: "${{ !cancelled() }}" },
          last: { needs: "middle" },
        },
      },
      {},
    );
    expect(result).toEqual({
      skipped: "skipped",
      middle: "success",
      last: "skipped",
    });
  });

  // #480-T01
  it("runs a job with a status function by its own condition", () => {
    const result = simulate(
      {
        on: {},
        jobs: {
          skipped: { if: "${{ 'a' == 'b' }}" },
          middle: { needs: "skipped", if: "${{ !cancelled() }}" },
          last: {
            needs: "middle",
            if: "${{ !cancelled() && needs.middle.result == 'success' }}",
          },
        },
      },
      {},
    );
    expect(result.last).toBe("success");
  });

  it("reads outputs, the repository and the ref, and refuses what it does not model", () => {
    const outputs = { first: { flag: "true" } };
    const run = (condition: string) =>
      simulate(
        {
          on: {},
          jobs: { first: {}, second: { needs: "first", if: condition } },
        },
        { outputs },
      ).second;
    expect(
      run(
        "${{ github.ref == 'refs/heads/main' && needs.first.outputs.flag == 'true' }}",
      ),
    ).toBe("success");
    expect(run("${{ needs.first.outputs.flag == 'false' }}")).toBe("skipped");
    expect(() => run("${{ failure() }}")).toThrow();
    expect(() => run("${{ contains(github.ref, 'main') }}")).toThrow();
  });
});

describe("the production deployment when the golden snapshot is reused", () => {
  // #480-T01
  it("promotes the App and then the Dispatcher, and cleans up, with nothing to write to Infisical", () => {
    expect(simulate(workflow, reuse)).toEqual({
      fresh: "success",
      migrate: "success",
      "snapshot-decide": "success",
      "snapshot-build": "skipped",
      "stage-app": "success",
      "stage-dispatcher": "success",
      "health-app": "success",
      canary: "success",
      "promote-app": "success",
      "promote-dispatcher": "success",
      persist: "skipped",
      cleanup: "success",
      discard: "skipped",
      record: "success",
    });
  });

  // #480-T01
  it("writes the pair when the variables are behind the live pair, with nothing rebuilt", () => {
    const result = simulate(workflow, {
      outputs: { "snapshot-decide": { rebuild: "false", repair: "true" } },
    });
    expect(result["snapshot-build"]).toBe("skipped");
    expect(result["promote-dispatcher"]).toBe("success");
    expect(result.persist).toBe("success");
    expect(result.cleanup).toBe("success");
  });

  // #480-T01
  it("still promotes, writes the pair and cleans up when the snapshot is rebuilt", () => {
    const result = simulate(workflow, rebuild);
    expect(result["snapshot-build"]).toBe("success");
    for (const name of [...PROMOTIONS, "persist", "cleanup"])
      expect(result[name], name).toBe("success");
    expect(result.discard).toBe("skipped");
  });
});

describe("what still stops the promotion", () => {
  const stops: Array<[string, Scenario]> = [
    ["the commit is not the head of main", { ...reuse, failing: ["fresh"] }],
    ["the migration fails", { ...reuse, failing: ["migrate"] }],
    ["the decision about the snapshot fails", { failing: ["snapshot-decide"] }],
    ["staging the App fails", { ...reuse, failing: ["stage-app"] }],
    [
      "staging the Dispatcher fails",
      { ...reuse, failing: ["stage-dispatcher"] },
    ],
    ["the staged App is not healthy", { ...reuse, failing: ["health-app"] }],
    ["the canary fails", { ...reuse, failing: ["canary"] }],
    ["the snapshot build fails", { ...rebuild, failing: ["snapshot-build"] }],
    ["the canary fails after a rebuild", { ...rebuild, failing: ["canary"] }],
    ["the run is cancelled", { ...reuse, cancelled: true }],
  ];

  // #480-T04
  it.each(stops)("promotes nothing when %s", (_case, scenario) => {
    const result = simulate(workflow, scenario);
    for (const name of PROMOTIONS) expect(result[name], name).toBe("skipped");
    // Nothing is written or removed for a promotion that did not happen.
    for (const name of ["persist", "cleanup"])
      expect(result[name], name).toBe("skipped");
  });

  // #480-T04
  it("does not promote the Dispatcher when promoting the App fails, and leaves the pair and the snapshots alone", () => {
    const result = simulate(workflow, { ...rebuild, failing: ["promote-app"] });
    expect(result["promote-app"]).toBe("failure");
    expect(result["promote-dispatcher"]).toBe("skipped");
    expect(result.persist).toBe("skipped");
    expect(result.cleanup).toBe("skipped");
  });

  // #480-T04
  it("records what happened to each project even when it stops", () => {
    for (const [, scenario] of stops)
      expect(simulate(workflow, scenario).record).toBe("success");
  });
});

describe("the conditions of the jobs that follow the snapshot build", () => {
  // #480-T03
  it("name a status function in every job that depends on snapshot-build, directly or through another job", () => {
    const dependents = dependentsOf(workflow, "snapshot-build");
    expect(dependents.sort()).toEqual(
      [
        "canary",
        "cleanup",
        "discard",
        "persist",
        "promote-app",
        "promote-dispatcher",
        "record",
        "stage-dispatcher",
      ].sort(),
    );
    for (const name of dependents)
      expect(hasStatusFunction(job(name)), name).toBe(true);
  });

  // #480-T02
  it("check every job a promotion needs for success, and accept skipped for snapshot-build alone", () => {
    for (const name of PROMOTIONS) {
      const condition = String(job(name).if);
      for (const need of needsOf(job(name)))
        expect(condition, `${name} checks ${need}`).toContain(
          `needs.${need}.result == 'success'`,
        );
      expect(condition, name).not.toMatch(
        /needs\.(?!snapshot-build\.)[\w-]+\.result == 'skipped'/,
      );
      expect(condition, name).not.toMatch(/\.result != /);
    }
    expect(String(job("stage-dispatcher").if)).toContain(
      "needs.snapshot-build.result == 'success' || needs.snapshot-build.result == 'skipped'",
    );
  });

  // #480-T05
  it("keep the guards and the canary in front of every promotion", () => {
    for (const name of PROMOTIONS) {
      const condition = String(job(name).if);
      expect(condition, name).toContain(
        "github.repository == 'ExpidetGames/code-reviewer'",
      );
      expect(condition, name).toContain("github.ref == 'refs/heads/main'");
      expect(needsOf(job(name)), name).toContain("canary");
      expect(condition, name).toContain("needs.canary.result == 'success'");
    }
    expect(needsOf(job("promote-dispatcher"))).toContain("promote-app");
  });
});
