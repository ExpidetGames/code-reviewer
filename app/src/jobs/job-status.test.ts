// SPDX-License-Identifier: Apache-2.0

// Pins down which status changes a job may make. Every pair of statuses is checked, so a new status
// or a new edge cannot slip in without this table changing with it.
import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  canTransition,
  statusesThatCanBecome,
  type JobStatus,
} from "./job-status.ts";

const ALLOWED: ReadonlyArray<readonly [JobStatus, JobStatus]> = [
  ["queued", "running"],
  ["queued", "superseded"],
  ["queued", "cancelled"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["running", "queued"],
];

describe("job status transitions", () => {
  // CR-27-T13
  it("allows exactly the documented transitions and no other pair", () => {
    const allowed = new Set(ALLOWED.map(([from, to]) => `${from}>${to}`));

    for (const from of JOB_STATUSES)
      for (const to of JOB_STATUSES)
        expect(canTransition(from, to), `${from} to ${to}`).toBe(
          allowed.has(`${from}>${to}`),
        );
  });

  // CR-27-T13
  it("never leaves a finished job: nothing leads back from succeeded, failed, superseded or cancelled", () => {
    for (const from of [
      "succeeded",
      "failed",
      "superseded",
      "cancelled",
    ] as const) {
      for (const to of JOB_STATUSES)
        expect(canTransition(from, to), `${from} to ${to}`).toBe(false);
    }
  });

  // CR-27-T13
  it("lets only a queued job become running", () => {
    expect(statusesThatCanBecome("running")).toEqual(["queued"]);
  });

  it("names the statuses a job can come from, for use in update conditions", () => {
    expect(statusesThatCanBecome("succeeded")).toEqual(["running"]);
    expect(statusesThatCanBecome("failed")).toEqual(["running"]);
    expect(statusesThatCanBecome("queued")).toEqual(["running"]);
    expect(statusesThatCanBecome("cancelled")).toEqual(["queued"]);
    expect(statusesThatCanBecome("superseded")).toEqual(["queued"]);
  });
});
