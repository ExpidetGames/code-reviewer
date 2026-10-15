// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.ts";
import { CapabilitiesPending } from "../core/types.ts";
import { noLauncher } from "./none.ts";
import { sandboxFromEnvironment } from "./sandbox-env.ts";
import { recordingLogger } from "../test-support/harness.ts";
import { GoldenRecordSchema } from "../snapshot/record.ts";
import { loadSettings } from "../config.ts";
import type { SandboxSdk } from "./vercel-sandbox.ts";

const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const PLATFORM_TOKEN = "dummy-platform-token-for-tests-0000";
const BASE = {
  RUNNER_API_URL: "http://127.0.0.1:9",
  RUNNER_TOKEN: "dummy-dispatcher-token-for-tests",
  DISPATCHER_MAX_RUNNING: "2",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET: "dummy-signing-secret-current-0000000000",
};

function configured(extra: Record<string, string> = {}) {
  return {
    SANDBOX_SNAPSHOT_ID: "snap_dummy_golden_0001",
    SANDBOX_IMAGE_DIGEST: IMAGE_DIGEST,
    ...extra,
  };
}

function refusal(env: Record<string, string>): ConfigError {
  try {
    sandboxFromEnvironment(env, () => Promise.reject(new Error("not loaded")));
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("the configuration was expected to be refused");
}

const never: () => Promise<SandboxSdk> = () =>
  Promise.reject(new Error("not loaded"));

describe("the Sandbox-Launcher's configuration from the environment", () => {
  // #329 (additional): not configured is fail closed, not an error
  it("is the launcher that advertises nothing when no snapshot is configured", async () => {
    const sandbox = sandboxFromEnvironment({}, never);
    const settings = loadSettings(BASE);

    const launcher = sandbox.launcher({
      settings,
      logger: recordingLogger(),
      background: () => undefined,
    });

    expect(launcher).toBe(noLauncher);
    expect(sandbox.secrets).toStrictEqual([]);
  });

  // #329 (additional)
  it("builds the Sandbox-Launcher, which advertises PR-Agent, when the snapshot and the image are configured", async () => {
    const sandbox = sandboxFromEnvironment(configured(), never);

    const launcher = sandbox.launcher({
      settings: loadSettings(BASE),
      logger: recordingLogger(),
      background: () => undefined,
    });

    expect(launcher).not.toBe(noLauncher);
    expect(
      await launcher.capabilities(new AbortController().signal),
    ).toStrictEqual(["pr-agent"]);
  });

  // #329 (additional): the record of the golden snapshot pipeline (#330) is what these variables hold
  it("accepts the snapshot id and the image id of a golden snapshot record as they are", () => {
    const record = GoldenRecordSchema.parse({
      version: 1,
      snapshotId: "snap_dummy_golden_0001",
      imageDigest: IMAGE_DIGEST,
      builtAt: "2026-10-15T12:00:00.000Z",
      region: "fra1",
      target: "sandbox",
    });

    const sandbox = sandboxFromEnvironment(
      {
        SANDBOX_SNAPSHOT_ID: record.snapshotId,
        SANDBOX_IMAGE_DIGEST: record.imageDigest,
      },
      never,
    );

    expect(
      sandbox.launcher({
        settings: loadSettings(BASE),
        logger: recordingLogger(),
        background: () => undefined,
      }),
    ).not.toBe(noLauncher);
  });

  // #329 (additional)
  it.each<[string, Record<string, string>, string]>([
    [
      "an image id without a snapshot",
      { SANDBOX_IMAGE_DIGEST: IMAGE_DIGEST },
      "SANDBOX_SNAPSHOT_ID",
    ],
    [
      "a snapshot without an image id",
      { SANDBOX_SNAPSHOT_ID: "snap_dummy_golden_0001" },
      "SANDBOX_IMAGE_DIGEST",
    ],
    [
      "a snapshot id with a space",
      configured({ SANDBOX_SNAPSHOT_ID: "snap x" }),
      "SANDBOX_SNAPSHOT_ID",
    ],
    [
      "an image id that is not a sha256 digest",
      configured({ SANDBOX_IMAGE_DIGEST: "latest" }),
      "SANDBOX_IMAGE_DIGEST",
    ],
    [
      "an image id of the wrong length",
      configured({ SANDBOX_IMAGE_DIGEST: "sha256:abc" }),
      "SANDBOX_IMAGE_DIGEST",
    ],
    [
      "a hand-over time of zero",
      configured({ SANDBOX_HANDOVER_SECONDS: "0" }),
      "SANDBOX_HANDOVER_SECONDS",
    ],
    [
      "a hand-over time that is not a number",
      configured({ SANDBOX_HANDOVER_SECONDS: "soon" }),
      "SANDBOX_HANDOVER_SECONDS",
    ],
    [
      "a token without a team",
      configured({
        VERCEL_TOKEN: PLATFORM_TOKEN,
        VERCEL_PROJECT_ID: "prj_dummy",
      }),
      "VERCEL_TEAM_ID",
    ],
    [
      "a token without a project",
      configured({
        VERCEL_TOKEN: PLATFORM_TOKEN,
        VERCEL_TEAM_ID: "team_dummy",
      }),
      "VERCEL_PROJECT_ID",
    ],
  ])("refuses %s and names the variable", (_what, env, variable) => {
    const error = refusal(env);

    expect(error.variable).toBe(variable);
    expect(error.message).not.toContain(PLATFORM_TOKEN);
    expect(error.message).not.toContain(IMAGE_DIGEST);
  });

  // #329 (additional): the platform token is a secret of this deployment
  it("reports the platform token as a secret so the logger masks it", () => {
    const sandbox = sandboxFromEnvironment(
      configured({
        VERCEL_TOKEN: PLATFORM_TOKEN,
        VERCEL_TEAM_ID: "team_dummy",
        VERCEL_PROJECT_ID: "prj_dummy",
        VERCEL_OIDC_TOKEN: "dummy-oidc-token-for-tests-0000",
      }),
      never,
    );

    expect(sandbox.secrets).toStrictEqual([
      PLATFORM_TOKEN,
      "dummy-oidc-token-for-tests-0000",
    ]);
  });

  // #329-R05
  it.each<[string, Record<string, string>, string]>([
    [
      "a margin below the floor",
      configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "179" }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
    [
      "a margin that is not a number",
      configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "long" }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
    [
      "a margin above an hour",
      configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "3601" }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
    [
      "a margin that does not cover the hand-over time",
      configured({
        SANDBOX_HANDOVER_SECONDS: "100",
        SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "249",
      }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
  ])("refuses %s and names the variable", (_what, env, variable) => {
    expect(refusal(env).variable).toBe(variable);
  });

  // #329-R05
  it("accepts the margin at its floor and in the middle", () => {
    for (const margin of ["180", "300", "3600"])
      expect(() =>
        sandboxFromEnvironment(
          configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: margin }),
          never,
        ),
      ).not.toThrow();
  });

  // #329-R06
  it("refuses a hand-over time that, with create, prepare and the image check, would pass the core's launch deadline", () => {
    const sandbox = sandboxFromEnvironment(
      configured({ SANDBOX_HANDOVER_SECONDS: "120" }),
      never,
    );
    const make = (launchDeadlineSeconds: number) => {
      const settings = loadSettings(BASE);
      return sandbox.launcher({
        settings: {
          ...settings,
          core: { ...settings.core, launchDeadlineSeconds },
        },
        logger: recordingLogger(),
        background: () => undefined,
      });
    };

    expect(() => make(300)).not.toThrow();
    expect(() => make(270)).not.toThrow();
    expect(() => make(269)).toThrowError(/SANDBOX_HANDOVER_SECONDS/);
  });

  // #329-T11
  it("refuses a worker configuration the Launcher cannot run at start, not at the first job", () => {
    const sandbox = sandboxFromEnvironment(configured(), never);
    const settings = loadSettings({
      ...BASE,
      DISPATCHER_WORKER_CONFIG: JSON.stringify({
        dynamic: { launcher: { vcpus: 3 } },
      }),
    });

    expect(() =>
      sandbox.launcher({
        settings,
        logger: recordingLogger(),
        background: () => undefined,
      }),
    ).toThrowError(/DISPATCHER_WORKER_CONFIG/);
  });

  // #329-T11
  it("accepts a worker configuration with its own size and memory per kind", () => {
    const sandbox = sandboxFromEnvironment(configured(), never);
    const settings = loadSettings({
      ...BASE,
      DISPATCHER_WORKER_CONFIG: JSON.stringify({
        dynamic: {
          launcher: { vcpus: 2 },
          container: { memory: { limit: "3g", reservation: "2g" } },
        },
        diff: { launcher: { vcpus: 1 } },
      }),
    });

    expect(() =>
      sandbox.launcher({
        settings,
        logger: recordingLogger(),
        background: () => undefined,
      }),
    ).not.toThrow();
  });
});

describe("the capability probe's configuration from the environment", () => {
  const launcherFor = (
    env: Record<string, string>,
    extra: Record<string, string> = {},
  ) =>
    sandboxFromEnvironment(env, never).launcher({
      settings: loadSettings({ ...BASE, ...extra }),
      logger: recordingLogger(),
      background: () => undefined,
    });

  // #331-T01
  it("puts the Sandbox-Launcher behind the capability probe: it can be asked for a probe, and opencode waits for it", async () => {
    const launcher = launcherFor(configured());
    const signal = new AbortController().signal;

    expect(launcher.probe).toBeTypeOf("function");
    await expect(
      launcher.capabilities(signal, "opencode"),
    ).rejects.toBeInstanceOf(CapabilitiesPending);
    expect(await launcher.capabilities(signal, "pr-agent")).toStrictEqual([
      "pr-agent",
    ]);
  });

  // #331-T02
  it("starts no probe for a deployment that is configured for Diff jobs only", async () => {
    const launcher = launcherFor(configured(), {
      DISPATCHER_ENGINES: "pr-agent",
    });

    expect(launcher.probe).toBeUndefined();
    expect(
      await launcher.capabilities(new AbortController().signal, "opencode"),
    ).toStrictEqual(["pr-agent"]);
  });

  // #331-T03
  it.each<[string, Record<string, string>, string]>([
    [
      "a time to live of 59 seconds",
      configured({ DISPATCHER_PROBE_TTL_SECONDS: "59" }),
      "DISPATCHER_PROBE_TTL_SECONDS",
    ],
    [
      "a time to live above a day",
      configured({ DISPATCHER_PROBE_TTL_SECONDS: "86401" }),
      "DISPATCHER_PROBE_TTL_SECONDS",
    ],
    [
      "a time to live that is not a number",
      configured({ DISPATCHER_PROBE_TTL_SECONDS: "hour" }),
      "DISPATCHER_PROBE_TTL_SECONDS",
    ],
    [
      "a probe time of 29 seconds",
      configured({ DISPATCHER_PROBE_TIMEOUT_SECONDS: "29" }),
      "DISPATCHER_PROBE_TIMEOUT_SECONDS",
    ],
    [
      "a probe time above ten minutes",
      configured({ DISPATCHER_PROBE_TIMEOUT_SECONDS: "601" }),
      "DISPATCHER_PROBE_TIMEOUT_SECONDS",
    ],
  ])("refuses %s and names the variable", (_what, env, variable) => {
    expect(refusal(env).variable).toBe(variable);
  });

  // #331-T03
  it("accepts the time to live and the probe time at their bounds", () => {
    const bounds: [string, string][] = [
      ["60", "30"],
      ["3600", "150"],
      ["86400", "600"],
    ];
    for (const [ttl, timeout] of bounds)
      expect(() =>
        sandboxFromEnvironment(
          configured({
            DISPATCHER_PROBE_TTL_SECONDS: ttl,
            DISPATCHER_PROBE_TIMEOUT_SECONDS: timeout,
          }),
          never,
        ),
      ).not.toThrow();
  });

  // #331-T09
  it.each<[string, Record<string, string>, string]>([
    [
      "a capability descriptor that is not JSON",
      configured({ RUNNER_DYNAMIC_CAPABILITIES: "tools" }),
      "RUNNER_DYNAMIC_CAPABILITIES",
    ],
    [
      "a capability descriptor that is not an object",
      configured({ RUNNER_DYNAMIC_CAPABILITIES: "[1]" }),
      "RUNNER_DYNAMIC_CAPABILITIES",
    ],
    [
      "a capability descriptor with a line break",
      configured({ RUNNER_DYNAMIC_CAPABILITIES: '{"a":1,\n"b":2}' }),
      "RUNNER_DYNAMIC_CAPABILITIES",
    ],
    [
      "a cost limit that is not a number",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "free" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
    [
      "a cost limit of zero",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "0" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
    [
      "a negative cost limit",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "-1" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
    [
      "a cost limit in exponent form",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "1e3" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
  ])("refuses %s at start and names the variable", (_what, env, variable) => {
    expect(refusal(env).variable).toBe(variable);
  });

  // #331-T09
  it("accepts the operator's Dynamic configuration as the self-hosted service has it", () => {
    expect(() =>
      sandboxFromEnvironment(
        configured({
          RUNNER_DYNAMIC_CAPABILITIES:
            '{"tool_choice_required":true,"max_output_tokens":4096}',
          RUNNER_DYNAMIC_MAX_COST_USD: "2.50",
        }),
        never,
      ),
    ).not.toThrow();
  });
});
