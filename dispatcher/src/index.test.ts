// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { REAP_PATH } from "./reaper/route.ts";
import { startApp, waitFor } from "./test-support/harness.ts";

const CRON_SECRET = "a-cron-secret-of-at-least-32-characters";

// The Sandbox SDK is replaced for the whole file: no test here may reach the platform. A test scripts `create`.
const sdk = vi.hoisted(() => ({
  create: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
  get: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
  list: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));

afterEach(() => {
  vi.unstubAllEnvs();
  sdk.create.mockReset();
  sdk.get.mockReset();
  sdk.list.mockReset();
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

  // #331-T01
  it("starts a canary VM for the first Dynamic call and asks the App to ask again, instead of claiming on the Launcher's word", async () => {
    stubEnvironment();
    stubSandbox();
    sdk.create.mockRejectedValue(
      Object.assign(new Error("unavailable"), {
        name: "APIError",
        response: { status: 503 },
      }),
    );
    const { default: app } = await import("./index.ts");
    const { signedRequest, webhookBody } =
      await import("./test-support/harness.ts");
    const call = () =>
      app.fetch(
        signedRequest({
          body: webhookBody({ reviewKind: "dynamic" }),
          nowSeconds: Math.floor(Date.now() / 1000),
          secret: "dummy-signing-secret-current-0000000000",
          keyId: "k1",
        }),
      );

    const first = await call();

    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
    await waitFor(() => sdk.create.mock.calls.length === 1, "the canary VM");
    expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({
      source: { type: "snapshot", snapshotId: "snap_dummy_golden_0001" },
      region: "fra1",
      persistent: false,
    });
    expect(String(JSON.stringify(sdk.create.mock.calls[0]?.[0]))).toContain(
      "canary",
    );
  });

  // #331-T02
  it("claims no Dynamic job while the canary cannot be made, and the App is told to try again", async () => {
    stubEnvironment();
    stubSandbox();
    sdk.create.mockRejectedValue(
      Object.assign(new Error("unavailable"), {
        name: "APIError",
        response: { status: 503 },
      }),
    );
    const { default: app } = await import("./index.ts");
    const { signedRequest, webhookBody } =
      await import("./test-support/harness.ts");
    const call = () =>
      app.fetch(
        signedRequest({
          body: webhookBody({ reviewKind: "dynamic" }),
          nowSeconds: Math.floor(Date.now() / 1000),
          secret: "dummy-signing-secret-current-0000000000",
          keyId: "k1",
        }),
      );
    await call();
    await waitFor(() => sdk.create.mock.calls.length === 1, "the canary VM");

    // The failed probe is remembered for a minute: no second VM, and the App is told to try again after what is
    // left of that minute (not "not capable", which it would hold against the job for ten minutes).
    await vi.waitFor(async () => {
      const response = await call();
      expect(response.status).toBe(503);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(20);
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
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
      // A Diff job never waits for, or starts, a canary VM (#331).
      expect(JSON.stringify(sdk.create.mock.calls[0]?.[0])).not.toContain(
        "canary",
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

  // #364-T18
  it("has no reaper route when no golden snapshot is configured, and calls no platform", async () => {
    stubEnvironment();
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    const { default: app } = await import("./index.ts");

    const response = await app.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(404);
    expect(sdk.list).not.toHaveBeenCalled();
  });

  // #364-T15
  it("refuses the reaper route without the cron secret and lists nothing, also when no secret is set", async () => {
    stubEnvironment();
    stubSandbox();
    const { default: app } = await import("./index.ts");

    const unset = await app.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(unset.status).toBe(401);
    expect(sdk.list).not.toHaveBeenCalled();
  });

  // #364-T15
  it("refuses the reaper route to the dispatcher credential", async () => {
    stubEnvironment();
    stubSandbox();
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    const { default: app } = await import("./index.ts");

    const response = await app.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, {
        headers: { authorization: "Bearer dummy-dispatcher-token-for-tests" },
      }),
    );

    expect(response.status).toBe(401);
    expect(sdk.list).not.toHaveBeenCalled();
  });

  // #364-T20
  it("reaps through the SDK for the cron secret: lists our VMs by prefix and one tag, and stops none when none is a leftover", async () => {
    stubEnvironment();
    stubSandbox();
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    sdk.list.mockResolvedValue(
      (async function* () {
        yield {
          name: "code-reviewer-golden-builder-20261015t030000z",
          createdAt: 1,
          status: "running",
          tags: { app: "code-reviewer", role: "golden-builder" },
        };
      })(),
    );
    const { default: app } = await import("./index.ts");

    const response = await app.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      status: "ok",
      listed: 1,
      candidates: 0,
      stopped: 0,
      kept: 0,
      unreadable: 0,
      failed: 0,
    });
    expect(sdk.list).toHaveBeenCalledTimes(1);
    expect(sdk.list.mock.calls[0]?.[0]).toMatchObject({
      namePrefix: "cr-",
      tags: { app: "code-reviewer" },
    });
    expect(sdk.get).not.toHaveBeenCalled();
  });

  // #364-T11
  it("answers 500 REAP_LIST_FAILED when the platform cannot be listed, without its text", async () => {
    stubEnvironment();
    stubSandbox();
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    sdk.list.mockRejectedValue(
      Object.assign(new Error("platform said dummy-detail"), {
        response: { status: 503 },
      }),
    );
    const { default: app } = await import("./index.ts");

    const response = await app.fetch(
      new Request(`http://dispatcher.test${REAP_PATH}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe(
      JSON.stringify({ status: "error", code: "REAP_LIST_FAILED" }),
    );
  });
});

function stubSandbox(): void {
  vi.stubEnv("SANDBOX_SNAPSHOT_ID", "snap_dummy_golden_0001");
  vi.stubEnv("SANDBOX_IMAGE_DIGEST", `sha256:${"d".repeat(64)}`);
}
