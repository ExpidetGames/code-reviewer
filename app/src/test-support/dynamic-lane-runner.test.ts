// SPDX-License-Identifier: Apache-2.0

// Pins down how the privileged Dynamic e2e lane starts the runner (#253): as root with exactly the
// capabilities and no-new-privileges of compose.dynamic.yml, with the environment of that file, and with
// nothing that would advertise `opencode` for it. The runner has to earn the advertisement through its own
// startup self-check; the lane only reads what the runner logged about it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  PRODUCTION_CAPABILITIES,
  advertisementOf,
  runnerCommand,
  runnerEnvironment,
} from "../../e2e/helpers/dynamic-runner.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const compose = parse(
  readFileSync(`${repoRoot}compose.dynamic.yml`, "utf8"),
) as {
  services: Record<
    string,
    { cap_add?: string[]; environment?: Record<string, string> }
  >;
};
const service = compose.services["runner-dynamic"];

const OPTIONS = {
  home: "/tmp/cr-lane-runner-abc",
  appUrl: "http://127.0.0.1:3418",
  llmBaseUrl: "http://127.0.0.1:40111/api/v1",
  python: "/work/runner/.venv/bin/python",
  wrapper: "/work/fakes/pr-agent/run_job_against_fake_llm.py",
  runnerToken: "dummy-runner-token-0123456789-abcdef",
};

describe("the runner of the privileged Dynamic e2e lane", () => {
  // #253-L02
  it("is started with the capabilities of compose.dynamic.yml, no others, and no-new-privileges", () => {
    const { command, args } = runnerCommand(
      "/work/runner/.venv/bin/code-reviewer-runner",
    );

    const composeCapabilities = (service?.cap_add ?? [])
      .map((name) => name.toLowerCase())
      .sort();
    expect([...PRODUCTION_CAPABILITIES].sort()).toEqual(composeCapabilities);
    expect(command).toBe("setpriv");
    expect(args).toContain(
      `--bounding-set=-all,${PRODUCTION_CAPABILITIES.map((name) => `+${name}`).join(",")}`,
    );
    expect(args).toContain("--inh-caps=-all");
    expect(args).toContain("--no-new-privs");
    expect(args.at(-1)).toBe("/work/runner/.venv/bin/code-reviewer-runner");
  });

  // #253-L02
  it("gets the settings of the Dynamic runner of compose.dynamic.yml and the address of the fake LLM through the job command only", () => {
    const environment = runnerEnvironment(OPTIONS);

    expect(environment.RUNNER_DIFF_JOB_USER).toBe(
      service?.environment?.RUNNER_DIFF_JOB_USER,
    );
    expect(environment.RUNNER_CONCURRENCY).toBe("1");
    expect(environment.RUNNER_API_URL).toBe(OPTIONS.appUrl);
    expect(
      JSON.parse(environment.RUNNER_DYNAMIC_CAPABILITIES ?? "null"),
    ).toEqual({
      tool_choice_required: true,
      structured_output: true,
      max_output_tokens: 4096,
    });
    expect(environment.PR_AGENT_COMMAND).toContain(OPTIONS.wrapper);
    expect(environment.PR_AGENT_COMMAND).toContain(OPTIONS.llmBaseUrl);
  });

  // #253-L03
  it("is given nothing that would advertise opencode, name the engine or the ripgrep: the self-check decides", () => {
    const environment = runnerEnvironment(OPTIONS);

    for (const name of [
      "RUNNER_ADVERTISED_ENGINES",
      "RUNNER_OPENCODE_COMMAND",
      "RUNNER_DYNAMIC_RIPGREP",
      "RUNNER_DYNAMIC_ENGINE_UID",
      "RUNNER_DYNAMIC_ENGINE_GID",
    ])
      expect(environment, name).not.toHaveProperty(name);
  });

  // #253-L03
  it("reads what the runner logged: advertised, refused with the reason, or not yet", () => {
    const advertised =
      "2026-10-14 03:00:00 INFO Dynamic Review: opencode is advertised, the startup self-check passed\n";
    const refused =
      "2026-10-14 03:00:00 WARNING Dynamic Review: opencode is not advertised, this runner serves Diff jobs only (dynamic_isolation_self_check_failed: network_probe_failed)\n";
    const cannotStart =
      "2026-10-14 03:00:00 ERROR cannot start: a capability could not be dropped\n";

    expect(advertisementOf("")).toEqual({ state: "pending" });
    expect(advertisementOf("INFO polling\n")).toEqual({ state: "pending" });
    expect(advertisementOf(advertised)).toEqual({ state: "advertised" });
    expect(advertisementOf(refused)).toEqual({
      state: "refused",
      line: refused.trim(),
    });
    expect(advertisementOf(cannotStart)).toEqual({
      state: "refused",
      line: cannotStart.trim(),
    });
    // A refusal is not undone by a later line, and the first word counts.
    expect(advertisementOf(refused + advertised).state).toBe("refused");
  });
});
