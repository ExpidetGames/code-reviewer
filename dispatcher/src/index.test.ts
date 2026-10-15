// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
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
});
