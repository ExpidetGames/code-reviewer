// SPDX-License-Identifier: Apache-2.0

// The Vercel project settings of the Dispatcher (vercel.json, #329). The supervision that stops a job's VM when its
// container ends is work held in `waitUntil`, so it lives as long as the function may: `maxDuration` is set here on
// purpose, as high as a Pro team can, and the region is the one the Sandbox VMs and snapshots are in.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "./config.ts";

const ROOT = join(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
  regions?: string[];
  functions?: Record<string, { maxDuration?: number }>;
};

// 800 s is generally available on Pro; up to 1800 s (30 minutes) is an extended maximum in beta for Pro and
// Enterprise, set per function, on Node.js 22 or 24 (vercel.com/docs/functions/configuring-functions/duration).
const PRO_EXTENDED_MAXIMUM_SECONDS = 1800;

describe("vercel.json of the Dispatcher", () => {
  // #329-R08
  it("runs the function in fra1, the region of the Sandbox VMs and snapshots", () => {
    expect(config.regions).toStrictEqual(["fra1"]);
  });

  // #329-R08
  it("sets the maximum duration of the entry's function explicitly, as high as Pro allows", () => {
    const entries = Object.entries(config.functions ?? {});

    expect(entries.map(([file]) => file)).toStrictEqual(["src/index.ts"]);
    expect(existsSync(join(ROOT, "src", "index.ts"))).toBe(true);
    expect(entries[0]?.[1].maxDuration).toBe(PRO_EXTENDED_MAXIMUM_SECONDS);
  });

  // #329-R08
  it("lets the function outlive a job of the default timeout plus its launch", () => {
    const { core } = loadSettings({
      RUNNER_API_URL: "http://127.0.0.1:9",
      RUNNER_TOKEN: "dummy-dispatcher-token-for-tests",
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: "k1",
      DISPATCHER_SIGNING_SECRET: "dummy-signing-secret-current-0000000000",
    });

    expect(
      core.jobTimeoutSeconds + core.launchDeadlineSeconds,
    ).toBeLessThanOrEqual(PRO_EXTENDED_MAXIMUM_SECONDS);
  });
});
