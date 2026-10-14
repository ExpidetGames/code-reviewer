// SPDX-License-Identifier: Apache-2.0

// Pins down the wiring of the privileged Dynamic e2e lane (#253): the CI job that runs it, the scripts that
// arrange its namespaces, its own Playwright configuration, and the rules it keeps (a private port pair, one
// build, the preflight before anything starts, the guard loaded before anything can connect, nothing
// skipped). That the lane works is its CI run; here the structure is judged, so a refactor cannot quietly drop
// a check or turn the lane into something that skips.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
} & Record<string, unknown>;
type Job = {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = { jobs: Record<string, Job> };

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const engineWorkflow = parse(read(".github/workflows/engine.yml")) as Workflow;
const wrapper = read("runner/scripts/run_dynamic_e2e.sh");
const namespace = read("runner/scripts/dynamic_e2e_namespace.sh");
const config = read("app/playwright.dynamic.config.ts");
const mainConfig = read("app/playwright.config.ts");

function lane(): Job {
  const found = ci.jobs["e2e-dynamic"];
  if (!found) throw new Error('ci.yml has no job "e2e-dynamic"');
  return found;
}

function steps(): Step[] {
  return lane().steps ?? [];
}

function commands(): string[] {
  return steps().flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

/** The position of the first line of a script that contains the text; fails when there is none. */
function at(script: string, text: string): number {
  const index = script.indexOf(text);
  expect(index, `"${text}" in the script`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("the CI job of the privileged Dynamic e2e lane", () => {
  // #253-C01
  it("runs the lane through its script, for every change of the app or the runner and for main", () => {
    expect(commands()).toContain("scripts/run_dynamic_e2e.sh");
    const run = steps().find((step) =>
      step.run?.includes("scripts/run_dynamic_e2e.sh"),
    );
    expect(run?.["working-directory"]).toBe("runner");
    expect(lane().if).toContain("needs.changes.outputs.app == 'true'");
    expect(lane().if).toContain("needs.changes.outputs.runner == 'true'");
    expect(lane().if).toContain("github.base_ref == 'main'");
    expect(lane().if).toContain("github.event_name == 'push'");
  });

  // #253-C02
  it("is a required part of the aggregate check, so a red lane blocks the merge", () => {
    expect(ci.jobs["ci-passed"]?.needs).toContain("e2e-dynamic");
  });

  // #253-C03
  it("never lets a failure pass: no continue-on-error, no skipped step, no filter on its tests", () => {
    for (const step of steps())
      expect(step["continue-on-error"]).toBeUndefined();
    expect(commands().join("\n")).not.toMatch(/--grep|\|\| true/);
    expect(wrapper + namespace).not.toMatch(/\|\| true/);
  });

  // #253-C04
  it("installs what the lane needs from the lockfiles and the pins: nftables, the browser, the runner, the pinned OpenCode", () => {
    const text = steps()
      .map((step) => `${step.uses ?? ""} ${step.run ?? ""}`)
      .join("\n");

    expect(text).toContain("pnpm install --frozen-lockfile");
    expect(text).toContain("playwright install --with-deps chromium");
    expect(text).toContain("uv sync --locked");
    expect(text).toMatch(/apt-get install .*nftables/);
    // The pinned `rg` and OpenCode come from the fetch scripts (size and SHA-256 of the pin files), never from apt.
    expect(text).not.toMatch(/apt-get install .*ripgrep/);
    const cache = steps().find((step) =>
      String(step.with?.path ?? "").includes("code-reviewer/opencode"),
    );
    const engineCache = (engineWorkflow.jobs.engine?.steps ?? []).find((step) =>
      String(step.with?.path ?? "").includes("code-reviewer/opencode"),
    );
    expect(cache?.with?.key).toBe(engineCache?.with?.key);
  });

  // #253-C05
  it("is read-only, without secrets, time limited and pinned like the other jobs", () => {
    expect(lane().permissions ?? { contents: "read" }).toEqual({
      contents: "read",
    });
    expect(lane()["timeout-minutes"]).toBeLessThanOrEqual(25);
    expect(JSON.stringify(lane())).not.toContain("secrets.");
    for (const step of steps())
      if (step.uses?.includes("/") && !step.uses.startsWith("actions/"))
        expect(step.uses, step.uses).toMatch(/@[0-9a-f]{40}/);
  });

  // #253-C05
  it("keeps the reports of a failing lane, with the log of the runner and of the app", () => {
    const upload = steps().find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(upload?.if).toContain("failure()");
    expect(String(upload?.with?.path)).toContain("app/test-results");
    expect(String(upload?.with?.path)).toContain("app/playwright-report");
  });
});

describe("the scripts of the lane", () => {
  // #253-N01
  it("run the lane as root in a network namespace of its own, with a pid namespace that ends everything with it", () => {
    expect(wrapper).toContain("set -euo pipefail");
    expect(wrapper).toContain(
      "unshare --net --mount --pid --fork --mount-proc",
    );
    expect(wrapper).toContain("sudo --preserve-env");
    expect(wrapper).toContain("scripts/dynamic_e2e_namespace.sh");
    expect(namespace).toContain("set -euo pipefail");
  });

  // #253-N02
  it("load the network guard before anything can connect, then check the lane, and only then run the journeys", () => {
    const guard = at(namespace, "nft -f");
    const route = at(namespace, "ip route add default");
    const tools = at(namespace, "/usr/local/bin/opencode");
    const preflight = at(namespace, "dynamic-preflight-command.ts");
    const playwright = at(
      namespace,
      "playwright test -c playwright.dynamic.config.ts",
    );
    const lastWord = at(namespace, "dynamic-lane-guard-command.ts");

    expect(guard).toBeLessThan(route);
    expect(tools).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(playwright);
    expect(playwright).toBeLessThan(lastWord);
    // Loopback is the only network; the way out leads into a veth pair nothing answers on.
    expect(namespace).toContain("ip link set lo up");
    expect(namespace).toContain("e2e/dynamic/guard.nft");
  });

  // #253-N03
  it("stage the tools where the Dynamic image has them, in this namespace only, and add the engine user", () => {
    expect(namespace).toContain("/usr/local/bin/rg");
    expect(namespace).toContain("/opt/code-reviewer/pins");
    expect(namespace).toContain("opencode-pin.json");
    expect(namespace).toContain("ripgrep-pin.json");
    expect(namespace).toContain("10101:cr-engine");
    expect(namespace).toContain("10001:cr-job");
    expect(namespace).toMatch(/mount -t overlay .* \/usr\/local\/bin/);
    expect(namespace).toMatch(/mount --bind .* \/etc\/passwd/);
    // The host is not changed: no useradd, no copy into /usr/local/bin outside of the overlay.
    expect(namespace).not.toMatch(/useradd|groupadd/);
  });

  // #253-N04
  it("fetch the pinned OpenCode and ripgrep, make the one build, and keep to a private port pair", () => {
    expect(wrapper).toContain("scripts/fetch_opencode.py");
    expect(wrapper).toContain("scripts/fetch_ripgrep.py");
    expect(wrapper.match(/pnpm build/g)).toHaveLength(1);
    expect(wrapper).toContain("E2E_REUSE_BUILD");
    expect(wrapper).toMatch(/3000:\*/);
    expect(wrapper).toMatch(/3100:\*/);
    expect(config).toMatch(/port === 3000 \|\| port === 3100/);
    // The configuration itself never builds: it starts the build that was made.
    expect(config).not.toMatch(/pnpm build|next build/);
  });

  // #253-N05
  it("end by checking that no process of the lane is left and by reading the guard once more", () => {
    expect(namespace).toContain("Processes of the lane are still running");
    expect(namespace).toMatch(/dynamic-lane-guard-command\.ts/);
    expect(namespace.trimEnd().endsWith('exit "$status"')).toBe(true);
  });
});

describe("the Playwright configuration of the lane", () => {
  // #253-N06
  it("is separate from the one of the other journeys, which never run the lane and are never run by it", () => {
    expect(config).toContain('testDir: "e2e/dynamic"');
    expect(config).toContain("playwright.config.ts");
    expect(mainConfig).toMatch(/testIgnore:[\s\S]*\/e2e\\\/dynamic\\\//);
    expect(mainConfig).not.toContain("e2e/dynamic");
  });

  // #253-N07
  it("runs one worker, has the preflight as its global setup and starts the fake GitHub and one app", () => {
    expect(config).toContain("workers: 1");
    expect(config).toContain(
      'globalSetup: "./e2e/dynamic/preflight.global-setup.ts"',
    );
    expect(config.match(/command:/g)).toHaveLength(2);
    expect(config).toContain("fakes/github/main.ts");
    expect(config).toContain("next start");
  });

  // #253-N08
  it("does not turn on the Dynamic Review gate of any shipped configuration", () => {
    // The lane turns it on in its own database through the admin API (the journey), nowhere else.
    expect(config).not.toMatch(/dynamic_review|DYNAMIC_REVIEW/);
    const shipped = [
      read("compose.yml"),
      read("compose.dynamic.yml"),
      read("compose.coolify.yml"),
      read("compose.large.yml"),
    ].join("\n");
    expect(shipped).not.toMatch(/dynamic_review|dynamicReview/);
  });
});
