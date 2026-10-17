// SPDX-License-Identifier: Apache-2.0

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createApp } from "../app.ts";
import { createBackgroundTracker } from "../background.ts";
import type { ProbeResult } from "../core/types.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  readContract,
  recordingLogger,
  settingsFor,
  startApp,
} from "../test-support/harness.ts";
import { webhookTrigger } from "../triggers/webhook.ts";

let fake: DispatcherAppFake;
beforeEach(async () => {
  fake = await startApp();
});
afterEach(async () => {
  await fake.close();
});

const PASSED: ProbeResult = {
  status: "passed",
  engines: ["pr-agent", "opencode"],
  reasons: [],
  checkedAt: "2026-10-15T12:00:00.000Z",
};
const DENIED: ProbeResult = {
  status: "denied",
  engines: ["pr-agent"],
  reasons: ["ipv6_not_disabled"],
  checkedAt: "2026-10-15T12:00:00.000Z",
};

function build(
  probe?: () => Promise<ProbeResult>,
  engines: ("pr-agent" | "opencode")[] = ["pr-agent", "opencode"],
  imageDigest?: string,
) {
  const launcher = createFakeLauncher(probe === undefined ? {} : { probe });
  const logger = recordingLogger();
  const app = createApp({
    settings: settingsFor(fake.url, { engines }),
    launcher,
    logger,
    background: createBackgroundTracker().run,
    trigger: webhookTrigger({
      keys: [{ kid: KEY_ID, secret: SIGNING_SECRET }],
    }),
    ...(imageDigest === undefined ? {} : { imageDigest }),
  });
  return { app, launcher, logger };
}

function post(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request("http://dispatcher.test/probe", { method: "POST", headers }),
  );
}

const authorized = { authorization: `Bearer ${DISPATCHER_TOKEN}` };

function validReport(): (document: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(readContract("runner-api.v1.json") as object);
  ajv.addSchema(readContract("probe-verdict.v1.json") as object);
  const check = ajv.getSchema(
    "https://github.com/ExpidetGames/code-reviewer/contracts/probe-verdict.v1.json#/$defs/ProbeReport",
  );
  if (check === undefined) throw new Error("no ProbeReport");
  return (document) => check(document) === true;
}

describe("POST /probe", () => {
  // #331-T05
  it.each<[string, Record<string, string>]>([
    ["no credential", {}],
    ["a wrong credential", { authorization: "Bearer dummy-not-the-token" }],
    ["the token without its scheme", { authorization: DISPATCHER_TOKEN }],
    ["another scheme", { authorization: `Basic ${DISPATCHER_TOKEN}` }],
    ["an empty credential", { authorization: "Bearer " }],
  ])("answers 401 for %s and creates no canary VM", async (_name, headers) => {
    const { app, launcher } = build(() => Promise.resolve(PASSED));

    const response = await post(app, headers);

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "RUNNER_UNAUTHORIZED",
        message: "The request could not be verified.",
      },
    });
    expect(launcher.probes).toBe(0);
  });

  // #331-T05
  it("answers every refusal with the same body, so that it does not say what was wrong", async () => {
    const { app } = build(() => Promise.resolve(PASSED));

    const refusals: Record<string, string>[] = [
      {},
      { authorization: "Bearer dummy-not-the-token" },
    ];
    const bodies = await Promise.all(
      refusals.map(async (headers) => (await post(app, headers)).text()),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  // #331-T05
  it("does not answer a GET", async () => {
    const { app, launcher } = build(() => Promise.resolve(PASSED));

    const response = await app.fetch(
      new Request("http://dispatcher.test/probe", { headers: authorized }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(launcher.probes).toBe(0);
  });

  // #331-T01
  it("forces a probe and answers 200 with the report when every configured engine is advertised", async () => {
    const { app, launcher } = build(() => Promise.resolve(PASSED));

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    const report: unknown = await response.json();
    expect(report).toStrictEqual({
      version: 1,
      status: "passed",
      ok: true,
      engines: ["pr-agent", "opencode"],
      reasons: [],
      checkedAt: "2026-10-15T12:00:00.000Z",
    });
    expect(validReport()(report)).toBe(true);
    expect(launcher.probes).toBe(1);
  });

  // #331-T02
  it("answers 503 with the stable reasons when the canary does not advertise a configured engine", async () => {
    const { app } = build(() => Promise.resolve(DENIED));

    const response = await post(app, authorized);

    expect(response.status).toBe(503);
    const report: unknown = await response.json();
    expect(report).toMatchObject({
      status: "denied",
      ok: false,
      engines: ["pr-agent"],
      reasons: ["ipv6_not_disabled"],
    });
    expect(validReport()(report)).toBe(true);
  });

  // #331-T02
  it("answers 503 with the failure code when the canary could not be run", async () => {
    const failed: ProbeResult = {
      status: "failed",
      engines: ["pr-agent"],
      reasons: [],
      failure: "probe_timeout",
      checkedAt: "2026-10-15T12:00:00.000Z",
    };
    const { app } = build(() => Promise.resolve(failed));

    const response = await post(app, authorized);

    expect(response.status).toBe(503);
    const report: unknown = await response.json();
    expect(report).toMatchObject({
      status: "failed",
      ok: false,
      failure: "probe_timeout",
    });
    expect(validReport()(report)).toBe(true);
  });

  // #331-T01
  it("does not need the canary to pass when the deployment is configured for Diff jobs only", async () => {
    const { app } = build(() => Promise.resolve(DENIED), ["pr-agent"]);

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  // #331-T02
  it("fails closed when the probe itself breaks, and says nothing of the error", async () => {
    const { app, logger } = build(() =>
      Promise.reject(
        new Error("boom with ghp_" + "0123456789abcdef0123456789abcdef0123"),
      ),
    );

    const response = await post(app, authorized);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toMatchObject({
      status: "failed",
      ok: false,
      failure: "probe_error",
    });
    expect(logger.text()).not.toContain("ghp_");
  });

  // #331-T02
  it("says that nothing is proven when the Launcher has no probe, and what it advertises", async () => {
    const { app } = build(undefined);

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      failure: "probe_not_supported",
      ok: true,
    });
  });
});

describe("the image id in the probe report", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;

  // #403-T12
  it("names the Worker image id this deployment is configured with, so that a deploy step can tell which image it proved", async () => {
    const { app } = build(() => Promise.resolve(PASSED), undefined, DIGEST);

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imageDigest: DIGEST });
  });

  // #403-T12
  it("leaves it out when no image is configured, and never takes it from anything but the configuration", async () => {
    const { app } = build(() => Promise.resolve(PASSED));

    const body = (await (await post(app, authorized)).json()) as Record<
      string,
      unknown
    >;

    expect(body).not.toHaveProperty("imageDigest");
  });

  // #403-T12
  it("drops a value that is not an image id", async () => {
    const { app } = build(
      () => Promise.resolve(PASSED),
      undefined,
      "sha256:not-a-digest",
    );

    const body = (await (await post(app, authorized)).json()) as Record<
      string,
      unknown
    >;

    expect(body).not.toHaveProperty("imageDigest");
  });

  // #403-T12
  it("is not shown to a caller without the credential", async () => {
    const { app } = build(() => Promise.resolve(PASSED), undefined, DIGEST);

    const response = await post(app);

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain(DIGEST);
  });
});
