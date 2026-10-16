// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { unknownCostAlertLine } from "./unknown-cost-alert.ts";

describe("the alert for a run that settled without a cost", () => {
  // #361-T10
  it("names the workspace and the job and nothing else", () => {
    const line = unknownCostAlertLine({
      workspaceId: "ws-1",
      jobId: "job-9",
    });

    expect(line).toBe(
      "[usage] job=job-9 workspace=ws-1 settled with an unknown cost (not bounded by a cost limit)",
    );
    expect(line.split("\n")).toHaveLength(1);
  });

  // #361-T10
  it("carries no figure, model, key or name, whatever the ids hold", () => {
    const line = unknownCostAlertLine({ workspaceId: "w", jobId: "j" });

    expect(line).not.toMatch(/\d/);
    expect(line).not.toMatch(/model|key|usd|cost=|slug|name/i);
  });
});
