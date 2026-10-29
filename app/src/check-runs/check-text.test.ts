// SPDX-License-Identifier: LicenseRef-Proprietary

// What the check run of a review says for each state of its job (#405): the status GitHub shows, a conclusion
// that is never red, a title, and a summary made of fixed sentences, counts and the link to the review. Nothing a
// pull request or a runner wrote reaches the text except a validated link and a code of the plain shape of one.
import { identityFor } from "../product-identity/identities.ts";
import { describe, expect, it } from "vitest";
import { JOB_STATUSES } from "../db/job-status.ts";
import { describeCheck, type CheckSubject } from "./check-text.ts";
import type { VerdictSkipReason } from "./verdict.ts";
import { getProductIdentity } from "../product-identity/current.ts";

const PRODUCT = getProductIdentity();

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
    expect(describeCheck(PRODUCT, subject({ status: "queued" }))).toMatchObject(
      {
        status: "queued",
        title: "Waiting",
      },
    );
  });

  // #405-T02
  it("is in progress and says it is reviewing", () => {
    expect(
      describeCheck(PRODUCT, subject({ status: "running" })),
    ).toMatchObject({
      status: "in_progress",
      title: "Reviewing",
    });
  });

  it("has no conclusion before it ends", () => {
    expect(
      describeCheck(PRODUCT, subject({ status: "queued" })),
    ).not.toHaveProperty("conclusion");
    expect(
      describeCheck(PRODUCT, subject({ status: "running" })),
    ).not.toHaveProperty("conclusion");
  });
});

describe("what the check run says about the verdict", () => {
  const skipped = (reason: VerdictSkipReason) =>
    describeCheck(
      PRODUCT,
      subject({
        status: "succeeded",
        verdict: { kind: "skip", reason },
      }),
    ).summary;

  // #405-T19 (review P2-1)
  it.each([
    [
      "review_incomplete",
      "did not cover everything",
      "complete review replaces it",
    ],
    ["no_model_work", "no model call", "complete review replaces it"],
    ["findings_unknown", "did not report", "reports its findings"],
    ["no_severity", "no severities", "Any finding"],
  ] as const)(
    "says that no verdict was submitted because of %s, and that an earlier request for changes stays",
    (reason, because, wayOut) => {
      const summary = skipped(reason);

      expect(summary).toContain("No review verdict was submitted");
      expect(summary).toContain(because);
      expect(summary).toContain("earlier request for changes");
      expect(summary).toContain(wayOut);
    },
  );

  // #405-T19 (review round 2): a Diff project under blocking never gets a verdict, so no later review replaces it.
  it("tells a Diff project how to get rid of an earlier request instead of promising a review that never comes", () => {
    const summary = skipped("no_severity");

    expect(summary).not.toContain("complete review replaces it");
    expect(summary).toContain("Off");
    expect(summary).toContain("by hand");
  });

  // #405-T18
  it("says the verdict is switched off, without the warning about an earlier request", () => {
    const summary = skipped("off");

    expect(summary).toContain("switched off");
    expect(summary).not.toContain("earlier request for changes");
  });

  // #405-T20
  it("says nothing extra when a verdict is submitted, and nothing before the review is done", () => {
    expect(
      describeCheck(
        PRODUCT,
        subject({
          status: "succeeded",
          verdict: { kind: "submit", event: "approve", blocking: 0 },
        }),
      ).summary,
    ).not.toContain("verdict");
    expect(
      describeCheck(
        PRODUCT,
        subject({
          status: "running",
          verdict: { kind: "skip", reason: "off" },
        }),
      ).summary,
    ).not.toContain("verdict");
  });
});

describe("the check run of a finished review", () => {
  // #405-T03
  it("succeeds and links to the review comment", () => {
    const check = describeCheck(
      PRODUCT,
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
      PRODUCT,
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
      PRODUCT,
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
      PRODUCT,
      subject({
        status: "succeeded",
        findings: { open: 0, bySeverity: null },
      }),
    );

    expect(check.summary).toContain("No open findings.");
  });

  // #405-T04
  it("says nothing about findings it does not know", () => {
    const check = describeCheck(PRODUCT, subject({ status: "succeeded" }));

    expect(check.summary).not.toMatch(/finding/i);
    expect(check.conclusion).toBe("success");
  });

  it("says that a review stopped early at its limit may be incomplete, and still succeeds", () => {
    const check = describeCheck(
      PRODUCT,
      subject({ status: "succeeded", stoppedEarly: "cost_limit" }),
    );

    expect(check.conclusion).toBe("success");
    expect(check.summary).toMatch(/cost limit/);
    expect(check.summary).toMatch(/incomplete/);
  });

  // #666-T01
  it("says that a review stopped at the cost limit of its project may be incomplete, and where to change it", () => {
    const check = describeCheck(
      PRODUCT,
      subject({ status: "succeeded", stoppedEarly: "project_cost_limit" }),
    );

    expect(check.conclusion).toBe("success");
    expect(check.summary).toMatch(/cost limit set for this project/);
    expect(check.summary).toMatch(/incomplete/);
    expect(check.summary).toMatch(/Limits in the project settings/);
  });

  // #553-R07
  it("says that a review stopped at its token limit may be incomplete, and still succeeds", () => {
    const check = describeCheck(
      PRODUCT,
      subject({ status: "succeeded", stoppedEarly: "token_limit" }),
    );

    expect(check.conclusion).toBe("success");
    expect(check.summary).toMatch(/token limit/);
    expect(check.summary).toMatch(/incomplete/);
  });

  it("leaves out a link that is not a web address", () => {
    for (const commentUrl of [
      "javascript:alert(1)",
      "not a url",
      "ftp://x/y",
    ]) {
      const check = describeCheck(
        PRODUCT,
        subject({ status: "succeeded", commentUrl }),
      );

      expect(check.detailsUrl).toBeUndefined();
      expect(check.summary).not.toContain("](");
    }
  });

  it("never lets a link break out of its markup", () => {
    const check = describeCheck(
      PRODUCT,
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
      PRODUCT,
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

  // #666-T04
  it("says that a Diff Review stopped at the cost limit of its project, and where to change it", () => {
    const check = describeCheck(
      PRODUCT,
      subject({
        status: "failed",
        errorCode: "cost_limit_reached",
        stoppedEarly: "project_cost_limit",
      }),
    );

    expect(check.conclusion).toBe("neutral");
    expect(check.summary).toContain("cost limit set for this project");
    expect(check.summary).toContain("Limits in the project settings");
    expect(check.summary).toContain("`cost_limit_reached`");
  });

  // #689-T26
  it("says that a Diff Review stopped at the maximum cost per review of code-review.com, with no way to raise it", () => {
    const check = describeCheck(
      PRODUCT,
      subject({
        status: "failed",
        errorCode: "cost_limit_reached",
        stoppedEarly: "cost_limit",
      }),
    );

    expect(check.summary).toContain(
      "maximum cost per review set by code-review.com",
    );
    expect(check.summary).not.toContain("Limits in the project settings");
    expect(check.summary).toContain("`cost_limit_reached`");
  });

  // #689-T26
  it("keeps the project wording when the cost limit that stopped it was the project's", () => {
    const check = describeCheck(
      PRODUCT,
      subject({
        status: "failed",
        errorCode: "cost_limit_reached",
        stoppedEarly: "project_cost_limit",
      }),
    );

    expect(check.summary).toContain("Limits in the project settings");
  });

  // #499-T13
  it("says that reviews are paused for a refused job of the hidden brake, with no code, number or window", () => {
    const check = describeCheck(
      PRODUCT,
      subject({ status: "failed", errorCode: "reviews_paused" }),
    );

    expect(check.conclusion).toBe("neutral");
    expect(check.summary).toContain("Reviews are paused for this workspace");
    expect(check.summary).not.toContain("`");
    expect(check.summary).not.toContain("reviews_paused");
    expect(check.summary).not.toMatch(/\d|hour|brake|window/i);
  });

  // #632-T02
  it("is neutral for a job refused because the billing setup is not complete, and says so with its stable code", () => {
    const check = describeCheck(
      PRODUCT,
      subject({ status: "failed", errorCode: "billing_rates_incomplete" }),
    );

    expect(check).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      title: "Review did not finish",
    });
    expect(check.summary).toContain("the billing setup is not complete");
    expect(check.summary).toContain("whoever runs code-review.com");
    expect(check.summary).toContain("`billing_rates_incomplete`");
  });

  // #405-T06
  it("is neutral for a timeout and a lease that ran out", () => {
    for (const errorCode of ["timeout", "lease_expired"]) {
      const check = describeCheck(
        PRODUCT,
        subject({ status: "failed", errorCode }),
      );

      expect(check.conclusion).toBe("neutral");
      expect(check.summary).toMatch(/run/);
    }
  });

  it("gives a code nobody knows a general sentence and shows it only when it has the shape of a code", () => {
    const known = describeCheck(
      PRODUCT,
      subject({ status: "failed", errorCode: "something_new" }),
    );
    const odd = describeCheck(
      PRODUCT,
      subject({ status: "failed", errorCode: "<script>alert(1)</script>" }),
    );

    expect(known.conclusion).toBe("neutral");
    expect(known.summary).toContain("`something_new`");
    expect(odd.summary).not.toContain("script");
  });

  // #405-T10
  it("is neutral for a cancel, with the reason", () => {
    const check = describeCheck(
      PRODUCT,
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
    const check = describeCheck(PRODUCT, subject({ status: "superseded" }));

    expect(check).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      title: "Superseded by a newer commit",
    });
    expect(check.summary).toMatch(/newer commit/);
  });

  it("links to a review that was posted although the run failed", () => {
    const check = describeCheck(
      PRODUCT,
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
        const check = describeCheck(PRODUCT, subject({ status, errorCode }));

        if (check.status === "completed")
          expect(["success", "neutral"]).toContain(check.conclusion);
        else expect(check.conclusion).toBeUndefined();
      }
  });

  it("is completed exactly when the job is final", () => {
    expect(
      JOB_STATUSES.filter(
        (status) =>
          describeCheck(PRODUCT, subject({ status })).status === "completed",
      ),
    ).toEqual(["succeeded", "failed", "superseded", "cancelled"]);
  });
});

describe("the check of another product", () => {
  const factory = identityFor("factory");

  // #740-T05
  it("names the product where the text says who requested changes", () => {
    const check = describeCheck(
      factory,
      subject({
        status: "succeeded",
        verdict: { kind: "skip", reason: "review_incomplete" },
      }),
    );

    expect(check.summary).toContain(
      "An earlier request for changes by Factory",
    );
    expect(JSON.stringify(check)).not.toMatch(/code-review\.com/i);
  });

  // #740-T05
  it("words a failed run for the product", () => {
    const check = describeCheck(
      factory,
      subject({ status: "failed", errorCode: "billing_rates_incomplete" }),
    );

    expect(check.summary).toContain("Ask whoever runs Factory.");
  });
});
