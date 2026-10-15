// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp, waitFor } from "./test-support/harness.ts";

// The Sandbox SDK is replaced for the whole file: no test here may reach the platform. A test scripts `create`.
const sdk = vi.hoisted(() => ({
  create: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
  get: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));

afterEach(() => {
  vi.unstubAllEnvs();
  sdk.create.mockReset();
  sdk.get.mockReset();
  vi.resetModules();
});

function stubEnvironment(): void {
  vi.stubEnv("RUNNER_API_URL", "http://127.0.0.1:9");
  vi.stubEnv("RUNNER_TOKEN", "dummy-dispatcher-token-for-tests");
  vi.stubEnv("DISPATCHER_MAX_RUNNING", "2");
  vi.stubEnv("DISPATCHER_SIGNING_KEY_ID", "k1");
  vi.stubEnv(
    "DISPATCHER_SIGNING_SECRET",
    "dummy-signing-secret-current-0000000000",
  );
}

describe("the Vercel entry", () => {
  // #327-T09
  it("default-exports a Hono app that serves /health", async () => {
    stubEnvironment();

    const { default: app } = await import("./index.ts");
    const response = await app.fetch(
      new Request("http://dispatcher.test/health"),
    );

    expect(response.status).toBe(200);
  });

  // #327 (additional): a launcher that is not built yet claims nothing
  it("advertises no engine until a Launcher is wired in, so every call is ignored as not_capable", async () => {
    stubEnvironment();
    const { default: app } = await import("./index.ts");
    const { signedRequest, webhookBody } =
      await import("./test-support/harness.ts");

    const response = await app.fetch(
      signedRequest({
        body: webhookBody(),
        nowSeconds: Math.floor(Date.now() / 1000),
        secret: "dummy-signing-secret-current-0000000000",
        keyId: "k1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ignored",
      reason: "not_capable",
    });
  });

  // #327-T07
  it("refuses to start with a bad setting and names the variable, not the value", async () => {
    stubEnvironment();
    vi.stubEnv("DISPATCHER_MAX_RUNNING", "zero");

    await expect(import("./index.ts")).rejects.toThrow(
      /DISPATCHER_MAX_RUNNING/,
    );
  });

  // #329 (additional): wired in, configured by the environment
  it("advertises the PR-Agent engine and not the Dynamic one once a golden snapshot is configured", async () => {
    stubEnvironment();
    stubSandbox();
    const { default: app } = await import("./index.ts");
    const { signedRequest, webhookBody } =
      await import("./test-support/harness.ts");

    const response = await app.fetch(
      signedRequest({
        body: webhookBody({ reviewKind: "dynamic" }),
        nowSeconds: Math.floor(Date.now() / 1000),
        secret: "dummy-signing-secret-current-0000000000",
        keyId: "k1",
      }),
    );

    // Dynamic is advertised only after the capability probe (#331): until then it is not claimed.
    expect(await response.json()).toMatchObject({
      status: "ignored",
      reason: "not_capable",
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  // #329 (additional)
  it("starts a Diff job through the SDK in fra1 from the configured snapshot, and releases the job when the platform refuses", async () => {
    const fake = await startApp();
    try {
      stubEnvironment();
      vi.stubEnv("RUNNER_API_URL", fake.url);
      stubSandbox();
      sdk.create.mockRejectedValue(
        Object.assign(new Error("too many requests"), {
          name: "APIError",
          response: { status: 429 },
        }),
      );
      const jobId = fake.enqueue();
      const { default: app } = await import("./index.ts");
      const { signedRequest, webhookBody } =
        await import("./test-support/harness.ts");

      const response = await app.fetch(
        signedRequest({
          body: webhookBody({ jobId, reviewKind: "diff" }),
          nowSeconds: Math.floor(Date.now() / 1000),
          secret: "dummy-signing-secret-current-0000000000",
          keyId: "k1",
        }),
      );

      expect(response.status).toBe(202);
      await waitFor(
        () => fake.requests().some((request) => request.route === "release"),
        "the release of the job",
      );
      expect(sdk.create).toHaveBeenCalledTimes(1);
      expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({
        source: { type: "snapshot", snapshotId: "snap_dummy_golden_0001" },
        region: "fra1",
        persistent: false,
      });
      expect(sdk.create.mock.calls[0]?.[0]).not.toHaveProperty(
        "failoverRegions",
      );
    } finally {
      await fake.close();
    }
  });

  // #329 (additional)
  it("refuses to start with a snapshot and no image id, and names the variable", async () => {
    stubEnvironment();
    vi.stubEnv("SANDBOX_SNAPSHOT_ID", "snap_dummy_golden_0001");

    await expect(import("./index.ts")).rejects.toThrow(/SANDBOX_IMAGE_DIGEST/);
  });
});

function stubSandbox(): void {
  vi.stubEnv("SANDBOX_SNAPSHOT_ID", "snap_dummy_golden_0001");
  vi.stubEnv("SANDBOX_IMAGE_DIGEST", `sha256:${"d".repeat(64)}`);
}
