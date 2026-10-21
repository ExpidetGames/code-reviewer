// SPDX-License-Identifier: Apache-2.0

// The App holds money for the longest a VM can live: the job timeout plus the VM margin (#498, app/src/billing/hold.ts).
// The App cannot read the Dispatcher's settings, so it carries their defaults as constants; this test pins them from the
// other side, so a default that moves here fails until the App follows (the App's own test, hold.test.ts, pins the same).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "./config.ts";
import { VM_TIMEOUT_MARGIN_SECONDS } from "./launchers/sandbox.ts";

const REPO = join(import.meta.dirname, "..", "..");

function constantOf(name: string): number {
  const source = readFileSync(join(REPO, "app/src/billing/hold.ts"), "utf8");
  const found = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  if (found?.[1] === undefined) throw new Error(`hold.ts has no ${name}`);
  return Number(found[1]);
}

describe("the hold the App takes for a Sandbox VM", () => {
  // #498-T16
  it("uses the Dispatcher's default VM margin", () => {
    expect(constantOf("VM_TIMEOUT_MARGIN_SECONDS")).toBe(
      VM_TIMEOUT_MARGIN_SECONDS,
    );
  });

  // #498-T16
  it("uses the Dispatcher's default job timeout", () => {
    const settings = loadSettings({
      RUNNER_API_URL: "https://app.example.test",
      RUNNER_TOKEN: "a-dispatcher-token-for-the-tests",
      DISPATCHER_MAX_RUNNING: "4",
      DISPATCHER_SIGNING_KEY_ID: "k1",
      DISPATCHER_SIGNING_SECRET: "a-signing-secret-of-at-least-32-characters",
    });

    expect(constantOf("DIFF_JOB_TIMEOUT_SECONDS")).toBe(
      settings.core.jobTimeoutSeconds,
    );
    expect(constantOf("DYNAMIC_JOB_TIMEOUT_SECONDS")).toBe(
      settings.core.jobTimeoutSeconds,
    );
  });
});
