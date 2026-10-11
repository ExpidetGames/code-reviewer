import { describe, expect, it } from "vitest";
import { JOB_STATUSES } from "../jobs/job-status.ts";
import {
  RUN_STATUS_ORDER,
  RUN_STATUS_PRESENTATION,
  isRunStatus,
  isSettled,
} from "./run-status.ts";

describe("the presentation of a run status", () => {
  // CR-35-T06
  it("gives every status its own label, its own symbol and a description", () => {
    const presentations = JOB_STATUSES.map(
      (status) => RUN_STATUS_PRESENTATION[status],
    );

    expect(new Set(presentations.map((p) => p.label)).size).toBe(
      JOB_STATUSES.length,
    );
    expect(new Set(presentations.map((p) => p.symbol)).size).toBe(
      JOB_STATUSES.length,
    );
    for (const presentation of presentations) {
      expect(presentation.label).not.toBe("");
      expect(presentation.description).toMatch(/\.$/);
    }
  });

  // CR-35-T06
  it("names the five states of the story in plain words", () => {
    expect(RUN_STATUS_PRESENTATION.queued.label).toBe("Waiting");
    expect(RUN_STATUS_PRESENTATION.running.label).toBe("Running");
    expect(RUN_STATUS_PRESENTATION.succeeded.label).toBe("Succeeded");
    expect(RUN_STATUS_PRESENTATION.failed.label).toBe("Failed");
    expect(RUN_STATUS_PRESENTATION.cancelled.label).toBe("Cancelled");
  });

  it("offers every status exactly once in the filter order", () => {
    expect([...RUN_STATUS_ORDER].sort()).toEqual([...JOB_STATUSES].sort());
  });

  it("calls only waiting and running runs unsettled", () => {
    expect(JOB_STATUSES.filter((status) => !isSettled(status))).toEqual([
      "queued",
      "running",
    ]);
  });

  it("recognises a status and nothing else", () => {
    expect(isRunStatus("failed")).toBe(true);
    expect(isRunStatus("FAILED")).toBe(false);
    expect(isRunStatus(undefined)).toBe(false);
  });
});
