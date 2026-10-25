// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JOB_TIMEOUT_SECONDS,
  maxVmMinutes,
  VM_TIMEOUT_MARGIN_SECONDS,
} from "./hold.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

describe("the longest a VM lives, which a hold is made for", () => {
  // #498-T16
  it("keeps the VM margin equal to the Dispatcher's default", () => {
    const source = read("dispatcher/src/launchers/sandbox.ts");
    const declared = /export const VM_TIMEOUT_MARGIN_SECONDS = (\d+);/.exec(
      source,
    );

    expect(declared?.[1]).toBe(String(VM_TIMEOUT_MARGIN_SECONDS));
  });

  // #498-T16
  it("keeps the job timeout of each kind equal to the Dispatcher's default", () => {
    const source = read("dispatcher/src/config.ts");
    const declared =
      /"DISPATCHER_JOB_TIMEOUT_SECONDS", \{\s*min: \d+,\s*max: \d+,\s*fallback: (\d+),/.exec(
        source,
      );

    expect(declared?.[1]).toBe(String(JOB_TIMEOUT_SECONDS.diff));
    expect(declared?.[1]).toBe(String(JOB_TIMEOUT_SECONDS.dynamic));
  });

  // #689-T15: the dollar limit of a hold is the operator's setting, not a constant that has to equal a default elsewhere.
  it("holds no Dynamic cost limit of its own: the operator's maximum per review is the caller's input", () => {
    expect(read("app/src/billing/hold.ts")).not.toMatch(
      /export const \w*COST_LIMIT\w* =/,
    );
  });

  // #498-T16
  it("rounds the job timeout plus the margin up to whole minutes", () => {
    expect(maxVmMinutes("diff")).toBe(
      Math.ceil((JOB_TIMEOUT_SECONDS.diff + VM_TIMEOUT_MARGIN_SECONDS) / 60),
    );
    expect(maxVmMinutes("dynamic")).toBe(
      Math.ceil((JOB_TIMEOUT_SECONDS.dynamic + VM_TIMEOUT_MARGIN_SECONDS) / 60),
    );
    expect(maxVmMinutes("diff")).toBe(25);
  });
});
