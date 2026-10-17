// SPDX-License-Identifier: Apache-2.0

// The review verdict the app submits after a successful review (#405): REQUEST_CHANGES for blocking findings,
// APPROVE otherwise, decided from the project's setting and the findings the runner reported. A Dynamic review has
// severities (`blocking` is P0); a Diff review has none, so `blocking` submits nothing for it and `any` counts its
// active findings. What is not known, or a review that stopped early without a blocker, never approves.
import { describe, expect, it } from "vitest";
import {
  decideVerdict,
  verdictBody,
  verdictMarker,
  type FindingCounts,
  type ReviewVerdictMode,
} from "./verdict.ts";

const NONE = { P0: 0, P1: 0, P2: 0, P3: 0 };
const dynamic = (by: Partial<typeof NONE>, open?: number): FindingCounts => {
  const counts = { ...NONE, ...by };
  return {
    open: open ?? counts.P0 + counts.P1 + counts.P2 + counts.P3,
    bySeverity: counts,
  };
};
const diff = (open: number): FindingCounts => ({ open, bySeverity: null });

function decide(
  mode: ReviewVerdictMode,
  findings: FindingCounts | null,
  stoppedEarly: string | null = null,
) {
  return decideVerdict({ mode, findings, stoppedEarly });
}

describe("the verdict setting off", () => {
  // #405-T18
  it("never submits a review", () => {
    expect(decide("off", dynamic({ P0: 2 }))).toEqual({
      kind: "skip",
      reason: "off",
    });
    expect(decide("off", dynamic({}))).toEqual({ kind: "skip", reason: "off" });
    expect(decide("off", diff(3))).toEqual({ kind: "skip", reason: "off" });
  });
});

describe("the verdict setting blocking on a Dynamic review", () => {
  // #405-T18
  it("requests changes while a P0 finding is open", () => {
    expect(decide("blocking", dynamic({ P0: 1, P2: 3 }))).toEqual({
      kind: "submit",
      event: "request_changes",
      blocking: 1,
    });
  });

  // #405-T18
  it("approves when only lower priorities are open", () => {
    expect(decide("blocking", dynamic({ P1: 2, P2: 1, P3: 4 }))).toEqual({
      kind: "submit",
      event: "approve",
      blocking: 0,
    });
  });

  // #405-T18
  it("approves a review with no finding", () => {
    expect(decide("blocking", dynamic({}))).toEqual({
      kind: "submit",
      event: "approve",
      blocking: 0,
    });
  });
});

describe("the verdict setting any on a Dynamic review", () => {
  // #405-T18
  it("requests changes for any open finding, down to P3", () => {
    expect(decide("any", dynamic({ P3: 1 }))).toEqual({
      kind: "submit",
      event: "request_changes",
      blocking: 1,
    });
  });

  it("counts the findings the summary left out for space", () => {
    expect(decide("any", dynamic({}, 2))).toEqual({
      kind: "submit",
      event: "request_changes",
      blocking: 2,
    });
  });

  // #405-T18
  it("approves a review with no finding", () => {
    expect(decide("any", dynamic({}))).toMatchObject({ event: "approve" });
  });
});

describe("a Diff review, whose findings have no severity", () => {
  // #405-T19
  it("submits nothing under blocking, because it cannot tell a blocker from a nit", () => {
    expect(decide("blocking", diff(0))).toEqual({
      kind: "skip",
      reason: "no_severity",
    });
    expect(decide("blocking", diff(4))).toEqual({
      kind: "skip",
      reason: "no_severity",
    });
  });

  // #405-T19
  it("requests changes under any while a finding is active, and approves when none is", () => {
    expect(decide("any", diff(2))).toEqual({
      kind: "submit",
      event: "request_changes",
      blocking: 2,
    });
    expect(decide("any", diff(0))).toEqual({
      kind: "submit",
      event: "approve",
      blocking: 0,
    });
  });
});

describe("what is not known or not complete", () => {
  // #405-T19
  it("submits nothing when the runner did not say what is open", () => {
    for (const mode of ["blocking", "any"] as const)
      expect(decide(mode, null)).toEqual({
        kind: "skip",
        reason: "findings_unknown",
      });
  });

  // #405-T19
  it("does not approve a review that stopped early, but still requests changes for a blocker it found", () => {
    expect(decide("blocking", dynamic({ P1: 1 }), "cost_limit")).toEqual({
      kind: "skip",
      reason: "review_incomplete",
    });
    expect(decide("any", dynamic({}), "time_limit")).toEqual({
      kind: "skip",
      reason: "review_incomplete",
    });
    expect(decide("blocking", dynamic({ P0: 1 }), "cost_limit")).toEqual({
      kind: "submit",
      event: "request_changes",
      blocking: 1,
    });
  });
});

describe("the body of the review", () => {
  const link = "https://github.test/acme/widgets/pull/7#issuecomment-1001";

  // #405-T20
  it("is a verdict line, the link to the review and the marker, and nothing of the findings", () => {
    const body = verdictBody({
      jobId: "job-1",
      event: "request_changes",
      mode: "blocking",
      blocking: 2,
      commentUrl: link,
    });

    expect(body).toContain("changes requested");
    expect(body).toContain("2 P0 findings");
    expect(body).toContain(`](${link})`);
    expect(body).toContain(verdictMarker("job-1"));
    expect(body.length).toBeLessThan(400);
  });

  // #405-T21
  it("says what was not found when it approves", () => {
    const blocking = verdictBody({
      jobId: "job-1",
      event: "approve",
      mode: "blocking",
      blocking: 0,
      commentUrl: link,
    });
    const any = verdictBody({
      jobId: "job-1",
      event: "approve",
      mode: "any",
      blocking: 0,
      commentUrl: null,
    });

    expect(blocking).toContain("approved");
    expect(blocking).toMatch(/no P0 finding/i);
    expect(any).toMatch(/no open finding/i);
    expect(any).not.toContain("](");
  });

  it("names the marker of one job only, so the review of another job is not mistaken for it", () => {
    expect(verdictMarker("job-1")).not.toBe(verdictMarker("job-2"));
    expect(verdictMarker("job-1")).toMatch(/^<!--.*-->$/);
  });
});
