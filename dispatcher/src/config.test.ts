// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ConfigError, loadSettings } from "./config.ts";

const SECRET = "a-signing-secret-of-at-least-32-characters";
const TOKEN = "a-dispatcher-token-for-the-tests";

const base: Record<string, string> = {
  RUNNER_API_URL: "https://app.example.test",
  RUNNER_TOKEN: TOKEN,
  DISPATCHER_MAX_RUNNING: "4",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET: SECRET,
};

function failure(env: Record<string, string>): ConfigError {
  try {
    loadSettings(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected the settings to be refused");
}

describe("the settings of the Dispatcher", () => {
  // #327 (additional)
  it("reads the settings with their defaults", () => {
    const { core, signingKeys } = loadSettings(base);

    expect(core).toMatchObject({
      appUrl: "https://app.example.test",
      token: TOKEN,
      poolId: "dispatcher",
      maxRunning: 4,
      engines: ["pr-agent", "opencode"],
      jobTimeoutSeconds: 1200,
      launchDeadlineSeconds: 300,
      workerConfig: { diff: {}, dynamic: {} },
    });
    expect(signingKeys).toStrictEqual([{ kid: "k1", secret: SECRET }]);
  });

  // #327-T10
  it("reads a previous signing key next to the current one", () => {
    const { signingKeys } = loadSettings({
      ...base,
      DISPATCHER_SIGNING_KEY_ID_PREVIOUS: "k0",
      DISPATCHER_SIGNING_SECRET_PREVIOUS:
        "the-previous-signing-secret-32-characters",
    });

    expect(signingKeys.map((key) => key.kid)).toStrictEqual(["k1", "k0"]);
  });

  // #327 (additional)
  it("reads the engines, the pool id, the timeout and the configuration per kind", () => {
    const { core } = loadSettings({
      ...base,
      DISPATCHER_ENGINES: "pr-agent",
      DISPATCHER_POOL_ID: "staging-1",
      DISPATCHER_JOB_TIMEOUT_SECONDS: "600",
      DISPATCHER_WORKER_CONFIG: JSON.stringify({
        dynamic: {
          container: { memory: { limit: "1500m" } },
          launcher: { vcpus: 1 },
        },
      }),
    });

    expect(core.engines).toStrictEqual(["pr-agent"]);
    expect(core.poolId).toBe("staging-1");
    expect(core.jobTimeoutSeconds).toBe(600);
    expect(core.workerConfig.dynamic).toStrictEqual({
      container: { memory: { limit: "1500m" } },
      launcher: { vcpus: 1 },
    });
    expect(core.workerConfig.diff).toStrictEqual({});
  });

  // #327-T07
  it.each([
    ["RUNNER_API_URL", { RUNNER_API_URL: undefined }],
    ["RUNNER_API_URL", { RUNNER_API_URL: "ftp://app.example.test" }],
    [
      "RUNNER_API_URL",
      { RUNNER_API_URL: "https://user:pass@app.example.test" },
    ],
    ["RUNNER_TOKEN", { RUNNER_TOKEN: undefined }],
    ["RUNNER_TOKEN", { RUNNER_TOKEN: "has a space" }],
    ["DISPATCHER_MAX_RUNNING", { DISPATCHER_MAX_RUNNING: undefined }],
    ["DISPATCHER_MAX_RUNNING", { DISPATCHER_MAX_RUNNING: "0" }],
    ["DISPATCHER_MAX_RUNNING", { DISPATCHER_MAX_RUNNING: "many" }],
    ["DISPATCHER_SIGNING_SECRET", { DISPATCHER_SIGNING_SECRET: "too-short" }],
    ["DISPATCHER_SIGNING_KEY_ID", { DISPATCHER_SIGNING_KEY_ID: "Bad Id" }],
    [
      "DISPATCHER_SIGNING_SECRET_PREVIOUS",
      { DISPATCHER_SIGNING_KEY_ID_PREVIOUS: "k0" },
    ],
    ["DISPATCHER_ENGINES", { DISPATCHER_ENGINES: "pr-agent,unknown" }],
    ["DISPATCHER_POOL_ID", { DISPATCHER_POOL_ID: "bad id!" }],
    ["DISPATCHER_WORKER_CONFIG", { DISPATCHER_WORKER_CONFIG: "{not json" }],
    [
      "DISPATCHER_WORKER_CONFIG",
      {
        DISPATCHER_WORKER_CONFIG: JSON.stringify({
          diff: { container: { privileged: true } },
        }),
      },
    ],
  ] as const)(
    "refuses a bad %s and names the variable, never a value",
    (variable, change) => {
      const env: Record<string, string> = { ...base };
      for (const [name, value] of Object.entries(change))
        if (value === undefined) delete env[name];
        else env[name] = value;

      const error = failure(env);

      expect(error.variable).toBe(variable);
      expect(error.message).toContain(variable);
      for (const secret of [SECRET, TOKEN, "pass"])
        expect(error.message).not.toContain(secret);
    },
  );

  // #327-T07
  it("refuses a signing secret equal to the dispatcher token (every secret is distinct)", () => {
    const error = failure({ ...base, RUNNER_TOKEN: SECRET });

    expect(error.variable).toBe("DISPATCHER_SIGNING_SECRET");
  });

  // #364-T16
  it("has no cron secret unless CRON_SECRET is set", () => {
    expect(loadSettings(base).cronSecret).toBeUndefined();
    expect(
      loadSettings({ ...base, CRON_SECRET: "   " }).cronSecret,
    ).toBeUndefined();
  });

  // #364-T17
  it("reads CRON_SECRET, the platform's own name for the secret its cron sends", () => {
    const secret = "a-cron-secret-of-at-least-32-characters";

    expect(loadSettings({ ...base, CRON_SECRET: secret }).cronSecret).toBe(
      secret,
    );
  });

  // #364-T17
  it.each<[string, Record<string, string>, string, string]>([
    [
      "is too short",
      { CRON_SECRET: "tiny-secret" },
      "CRON_SECRET",
      "too_short",
    ],
    [
      "has a space",
      { CRON_SECRET: "a cron secret with spaces in it 0123456789" },
      "CRON_SECRET",
      "invalid",
    ],
    [
      "has a control character",
      { CRON_SECRET: "a-cron-secret-with-a-tab\t-0123456789" },
      "CRON_SECRET",
      "invalid",
    ],
    [
      "equals the dispatcher credential",
      {
        CRON_SECRET: TOKEN.padEnd(32, "x"),
        RUNNER_TOKEN: TOKEN.padEnd(32, "x"),
      },
      "CRON_SECRET",
      "not_distinct",
    ],
    [
      "equals the signing secret",
      { CRON_SECRET: SECRET },
      "CRON_SECRET",
      "not_distinct",
    ],
    [
      "equals the previous signing secret",
      {
        CRON_SECRET: "the-previous-signing-secret-32-characters",
        DISPATCHER_SIGNING_KEY_ID_PREVIOUS: "k0",
        DISPATCHER_SIGNING_SECRET_PREVIOUS:
          "the-previous-signing-secret-32-characters",
      },
      "CRON_SECRET",
      "not_distinct",
    ],
  ])(
    "refuses a CRON_SECRET that %s, naming the variable and never the value",
    (_name, env, variable, reason) => {
      const error = failure({ ...base, ...env });

      expect(error.variable).toBe(variable);
      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain(env.CRON_SECRET ?? "unreachable");
    },
  );
});
