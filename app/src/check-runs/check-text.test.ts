// SPDX-License-Identifier: Apache-2.0

// What the check run of a review says for each state of its job (#405): the status GitHub shows, a conclusion
// that is never red, a title, and a summary made of fixed sentences, counts and the link to the review. Nothing a
// pull request or a runner wrote reaches the text except a validated link and a code of the plain shape of one.
import { describe, expect, it } from "vitest";
import { JOB_STATUSES } from "../jobs/job-status.ts";
import { describeCheck, type CheckSubject } from "./check-text.ts";

const COMMENT = "https://github.test/acme/widgets/pull/7#issuecomment-1001";

function subject(overrides: Partial<CheckSubject> = {}): CheckSubject {
  return {
    status: "queued",
    errorCode: null,
    commentUrl: null,
    findings: null,
    stoppedEarly: null,
    ...overrides,
  };
}

describe("the check run of a job that waits or runs", () => {
  // #405-T01
  it("is queued and says it is waiting", () => {
    expect(describeCheck(subject({ status: "queued" }))).toMatchObject({
      status: "queued",
      title: "Waiting",
    });
  });

  // #405-T02
  it("is in progress and says it is reviewing", () => {
    expect(describeCheck(subject({ status: "running" }))).toMatchObject({
      status: "in_progress",
      title: "Reviewing",
    });
  });

  it("has no conclusion before it ends", () => {
    expect(describeCheck(subject({ status: "queued" }))).not.toHaveProperty(
      "conclusion",
    );
    expect(describeCheck(subject({ status: "running" }))).not.toHaveProperty(
      "conclusion",
    );
  });
});

describe("the check run of a finished review", () => {
  // #405-T03
  it("succeeds and links to the review comment", () => {
    const check = describeCheck(
      subject({ status: "succeeded", commentUrl: COMMENT }),
    );

    expect(check).toMatchObject({
      status: "completed",
      conclusion: "success",
      title: "Review finished",
      detailsUrl: COMMENT,
    });
    expect(check.summary).toContain(`](${COMMENT})`);
  });

  // #405-T04
  it("counts the open findings per severity of a Dynamic review", () => {
    const check = describeCheck(
      subject({
        status: "succeeded",
        findings: { open: 3, bySeverity: { P0: 1, P1: 0, P2: 2, P3: 0 } },
      }),
    );

    expect(check.summary).toContain(
      "3 open findings: P0 1 · P1 0 · P2 2 · P3 0",
    );
  });

  // #405-T04
  it("counts the open findings of a Diff review without a breakdown", () => {
    const check = describeCheck(
      subject({
        status: "succeeded",
        findings: { open: 1, bySeverity: null },
      }),
    );

    expect(check.summary).toContain("1 open finding.");
    expect(check.summary).not.toContain("P0");
  });

  // #405-T04
  it("says no finding is open when none is", () => {
    const check = describeCheck(
      subject({
        status: "succeeded",
        findings: { open: 0, bySeverity: null },
      }),
    );

    expect(check.summary).toContain("No open findings.");
  });

  // #405-T04
  it("says nothing about findings it does not know", () => {
    const check = describeCheck(subject({ status: "succeeded" }));

    expect(check.summary).not.toMatch(/finding/i);
    expect(check.conclusion).toBe("success");
  });

  it("says that a review stopped early at its limit may be incomplete, and still succeeds", () => {
    const check = describeCheck(
      subject({ status: "succeeded", stoppedEarly: "cost_limit" }),
    );

    expect(check.conclusion).toBe("success");
    expect(check.summary).toMatch(/cost limit/);
    expect(check.summary).toMatch(/incomplete/);
  });

  it("leaves out a link that is not a web address", () => {
    for (const commentUrl of [
      "javascript:alert(1)",
      "not a url",
      "ftp://x/y",
    ]) {
      const check = describeCheck(subject({ status: "succeeded", commentUrl }));

      expect(check.detailsUrl).toBeUndefined();
      expect(check.summary).not.toContain("](");
    }
  });

  it("never lets a link break out of its markup", () => {
    const check = describeCheck(
      subject({
        status: "succeeded",
        commentUrl: "https://github.test/a b)(https://evil.test",
      }),
    );

    // One link, so one opening and one closing parenthesis: the ones in the address are encoded.
    expect(check.summary.match(/\(/g)).toHaveLength(1);
    expect(check.summary.match(/\)/g)).toHaveLength(1);
    expect(check.detailsUrl).not.toMatch(/[()\s]/);
  });
});

describe("the check run of a job that did not finish", () => {
  // #405-T05
  it("is neutral for a failure, with the readable reason and the code", () => {
    const check = describeCheck(
      subject({ status: "failed", errorCode: "llm_auth" }),
    );

    expect(check).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      title: "Review did not finish",
    });
    expect(check.summary).toContain("The AI provider refused the API key.");
    expect(check.summary).toContain("`llm_auth`");
  });

  // #405-T06
  it("is neutral for a timeout and a lease that ran out", () => {
    for (const errorCode of ["timeout", "lease_expired"]) {
      const check = describeCheck(subject({ status: "failed", errorCode }));

      expect(check.conclusion).toBe("neutral");
      expect(check.summary).toMatch(/run/);
    }
  });

  it("gives a code nobody knows a general sentence and shows it only when it has the shape of a code", () => {
    const known = describeCheck(
      subject({ status: "failed", errorCode: "something_new" }),
    );
    const odd = describeCheck(
      subject({ status: "failed", errorCode: "<script>alert(1)</script>" }),
    );

    expect(known.conclusion).toBe("neutral");
    expect(known.summary).toContain("`something_new`");
    expect(odd.summary).not.toContain("script");
  });

  // #405-T10
  it("is neutral for a cancel, with the reason", () => {
    const check = describeCheck(
      subject({ status: "cancelled", errorCode: "pull_request_closed" }),
    );

    expect(check).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      title: "Review cancelled",
    });
    expect(check.summary).toContain("The pull request was closed");
  });

  // #405-T08
  it("says it was superseded by a newer commit", () => {
    const check = describeCheck(subject({ status: "superseded" }));

    expect(check).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      title: "Superseded by a newer commit",
    });
    expect(check.summary).toMatch(/newer commit/);
  });

  it("links to a review that was posted although the run failed", () => {
    const check = describeCheck(
      subject({
        status: "failed",
        errorCode: "review_text_truncated",
        commentUrl: COMMENT,
      }),
    );

    expect(check.summary).toContain(`](${COMMENT})`);
  });
});

describe("every check run", () => {
  // #405 (the maintainer's rule: the check is never red)
  it("has a conclusion of success or neutral, whatever the status of the job and its code", () => {
    for (const status of JOB_STATUSES)
      for (const errorCode of [null, "timeout", "llm_auth", "unheard_of"]) {
        const check = describeCheck(subject({ status, errorCode }));

        if (check.status === "completed")
          expect(["success", "neutral"]).toContain(check.conclusion);
        else expect(check.conclusion).toBeUndefined();
      }
  });

  it("is completed exactly when the job is final", () => {
    expect(
      JOB_STATUSES.filter(
        (status) => describeCheck(subject({ status })).status === "completed",
      ),
    ).toEqual(["succeeded", "failed", "superseded", "cancelled"]);
  });
});
