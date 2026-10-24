// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { systemClock } from "../core/clock.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import { startNodeServer, type NodeServer } from "../node.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  recordingLogger,
  startApp,
} from "../test-support/harness.ts";
import { runCanary } from "./canary.ts";

let fake: DispatcherAppFake;
let server: NodeServer | undefined;

beforeEach(async () => {
  fake = await startApp();
});
afterEach(async () => {
  await server?.shutdown();
  server = undefined;
  await fake.close();
});

async function serve(
  probe: Parameters<typeof createFakeLauncher>[0] = {},
  token = DISPATCHER_TOKEN,
) {
  const launcher = createFakeLauncher(probe);
  server = await startNodeServer({
    env: {
      RUNNER_API_URL: fake.url,
      RUNNER_TOKEN: token,
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: KEY_ID,
      DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
    },
    launcher,
    port: 0,
    hostname: "127.0.0.1",
    logger: recordingLogger(),
  });
  return { launcher, url: `http://127.0.0.1:${server.port}` };
}

async function canary(url: string, token = DISPATCHER_TOKEN) {
  const lines: string[] = [];
  const status = await runCanary({
    url,
    token,
    clock: systemClock,
    write: (line) => lines.push(line),
  });
  return { status, text: lines.join("\n") };
}

describe("the deploy canary against a running Dispatcher", () => {
  // #331-T01
  it("passes when the Dispatcher's probe passes", async () => {
    const { url, launcher } = await serve({
      probe: () =>
        Promise.resolve({
          status: "passed",
          engines: ["pr-agent", "opencode"],
          reasons: [],
          checkedAt: "2026-10-15T12:00:00.000Z",
        }),
    });

    const result = await canary(url);

    expect(result.status).toBe(0);
    expect(launcher.probes).toBe(1);
  });

  // #331-T02
  it("blocks the release when the probe is denied, and says why in stable words", async () => {
    const { url } = await serve({
      probe: () =>
        Promise.resolve({
          status: "denied",
          engines: ["pr-agent"],
          reasons: ["network_rules_not_installed"],
          checkedAt: "2026-10-15T12:00:00.000Z",
        }),
    });

    const result = await canary(url);

    expect(result.status).toBe(1);
    expect(result.text).toContain("network_rules_not_installed");
  });

  // #331-T05
  it("blocks the release and starts no probe when the credential is wrong", async () => {
    const { url, launcher } = await serve({
      probe: () => Promise.reject(new Error("must not run")),
    });

    const result = await canary(url, "dummy-wrong-credential-0000");

    expect(result.status).toBe(1);
    expect(result.text).toContain("401");
    expect(launcher.probes).toBe(0);
  });
});
