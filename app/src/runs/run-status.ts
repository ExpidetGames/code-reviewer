// SPDX-License-Identifier: LicenseRef-Proprietary

// How a run's status looks to a person: one label, one symbol and one description per status. Pure
// data, no React, so the list, the detail page and the project list say the same thing. A status is
// never told apart by color alone: the label is text and the symbol is a different shape for each.
import { JOB_STATUSES, type JobStatus } from "../jobs/job-status.ts";

/** The symbols of the run statuses, as the design board pairs them (#633, #636). */
export type RunStatusSymbol =
  "hourglass" | "play" | "check" | "x" | "prohibit" | "arrow-clockwise";

export type RunStatusPresentation = {
  label: string;
  /** A short sentence for the detail page and for assistive technology. */
  description: string;
  /**
   * The name of a Phosphor icon that differs per status (#636); decoration only (the label carries the
   * meaning). A name, not a component, so this module stays free of React; the badge draws it.
   */
  symbol: RunStatusSymbol;
  /** Whether the run can still change (the pages poll while one of these is shown). */
  settled: boolean;
};

export const RUN_STATUS_PRESENTATION: Record<JobStatus, RunStatusPresentation> =
  {
    queued: {
      label: "Waiting",
      description: "Waiting for a runner to pick it up.",
      symbol: "hourglass",
      settled: false,
    },
    running: {
      label: "Running",
      description: "A runner is working on it now.",
      symbol: "play",
      settled: false,
    },
    succeeded: {
      label: "Succeeded",
      description: "The review was published.",
      symbol: "check",
      settled: true,
    },
    failed: {
      label: "Failed",
      description: "The run ended without a review.",
      symbol: "x",
      settled: true,
    },
    cancelled: {
      label: "Cancelled",
      description: "The run was stopped before it produced a review.",
      symbol: "prohibit",
      settled: true,
    },
    superseded: {
      label: "Superseded",
      description:
        "A newer push replaced this run, so it was stopped and a newer run took its place. A review it had not published is not on the pull request.",
      symbol: "arrow-clockwise",
      settled: true,
    },
  };

/** The statuses a run can have, in the order a filter offers them. */
export const RUN_STATUS_ORDER: readonly JobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
];

export function isRunStatus(value: unknown): value is JobStatus {
  return JOB_STATUSES.some((status) => status === value);
}

/** Whether a run in this status can still change. */
export function isSettled(status: JobStatus): boolean {
  return RUN_STATUS_PRESENTATION[status].settled;
}
