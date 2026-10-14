// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import {
  cleanLog,
  MAX_LOG_CHARS,
  readStoredResult,
  readStoredUsage,
  safeGithubUrl,
  toRunDetailView,
  toRunRowView,
} from "./run-view.ts";
import { UNKNOWN_ERROR_COPY } from "./error-copy.ts";

const NOW = new Date("2026-10-10T12:10:00.000Z");

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    prNumber: 7,
    prUrl: "https://github.com/acme/widgets/pull/7",
    headSha: "a".repeat(40),
    reviewKind: "diff",
    command: "review",
    args: "",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: "delivery-1",
    status: "succeeded",
    runAfter: "2026-10-10T12:00:00.000Z",
    attempts: 0,
    runnerId: "runner-secret-name",
    claimedAt: "2026-10-10T12:00:10.000Z",
    heartbeatAt: "2026-10-10T12:00:40.000Z",
    leaseExpiresAt: "2026-10-10T12:02:40.000Z",
    result: null,
    errorCode: null,
    supersededBy: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:01:00.000Z",
    finishedAt: "2026-10-10T12:01:00.000Z",
    ...overrides,
  };
}

describe("the links of a run", () => {
  // CR-35-T14
  it("accepts an https address on github.com and nothing else", () => {
    expect(
      safeGithubUrl("https://github.com/acme/widgets/pull/7#issuecomment-1"),
    ).toBe("https://github.com/acme/widgets/pull/7#issuecomment-1");

    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://github.com/acme/widgets/pull/7",
      "https://evil.example/acme/widgets/pull/7",
      "https://github.com.evil.example/acme",
      "https://github.com.evil.com/acme/widgets/pull/7",
      "https://evilgithub.com/acme/widgets/pull/7",
      "https://notgithub.com/acme",
      "https://gist.github.com/acme",
      "https://www.github.com/acme",
      "https://evil.example/https://github.com/",
      "https://user:pw@github.com/acme",
      "https://github.com:8443/acme",
      "//github.com/acme",
      "github.com/acme",
      "",
      "x".repeat(3000),
      null,
      undefined,
      42,
    ]) {
      expect(safeGithubUrl(bad)).toBeNull();
    }
  });
});

describe("the log of a run", () => {
  // CR-35-T13
  it("removes terminal escapes and control characters but keeps text and line breaks", () => {
    const raw =
      "\u001b[31mred\u001b[0m line\r\nnext\tcolumn\u0007\u0000\n" +
      "\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 <b>html</b> ‮evil";

    expect(cleanLog(raw)).toBe("red line\nnext\tcolumn\nlink <b>html</b> evil");
  });

  it("reads only the comment link, the log and the truncation flag of a stored result", () => {
    expect(
      readStoredResult({
        ok: true,
        commentUrl: "https://github.com/a/b/pull/1#c",
        logTail: "line",
        logTruncated: true,
        usage: { costUsd: 0.1 },
      }),
    ).toEqual({
      commentUrl: "https://github.com/a/b/pull/1#c",
      logTail: "line",
      logTruncated: true,
    });
    for (const odd of [null, "text", 7, [], { logTail: 5, commentUrl: {} }]) {
      expect(readStoredResult(odd)).toEqual({
        commentUrl: null,
        logTail: "",
        logTruncated: false,
      });
    }
  });
});

describe("the usage of a run", () => {
  const usage = {
    model: "vendor/dynamic-model",
    promptTokens: 12000,
    completionTokens: 900,
    totalTokens: 12900,
    aiCalls: 7,
    fallbackUsed: false,
    costUsd: 0.04,
  };

  // #201-T01
  it("reads the model, the summed tokens, the model calls and the cost of a stored result, and nothing else of it", () => {
    expect(readStoredUsage({ ok: true, usage })).toEqual({
      model: "vendor/dynamic-model",
      totalTokens: 12900,
      aiCalls: 7,
      costUsd: 0.04,
    });
  });

  // #201-T01
  it("keeps a cost the runner could not know as unknown instead of zero", () => {
    expect(
      readStoredUsage({ ok: true, usage: { ...usage, costUsd: null } }),
    ).toMatchObject({ costUsd: null });
  });

  // #201-T01
  it.each([
    ["no result", null],
    ["a result without usage", { ok: true }],
    ["usage null", { ok: true, usage: null }],
    ["usage of the wrong type", { ok: true, usage: "12900 tokens" }],
    [
      "tokens that are not a number",
      { ok: true, usage: { ...usage, totalTokens: "many" } },
    ],
    ["negative tokens", { ok: true, usage: { ...usage, totalTokens: -1 } }],
    [
      "a fractional call count",
      { ok: true, usage: { ...usage, aiCalls: 1.5 } },
    ],
    [
      "a cost that is not finite",
      { ok: true, usage: { ...usage, costUsd: Infinity } },
    ],
  ])("shows no usage for %s", (_name, stored) => {
    expect(readStoredUsage(stored)).toBeNull();
  });

  // #201-T01
  it("takes a model without a name as unknown and cleans one that has control characters", () => {
    expect(
      readStoredUsage({ ok: true, usage: { ...usage, model: null } }),
    ).toMatchObject({ model: null });
    expect(
      readStoredUsage({
        ok: true,
        usage: { ...usage, model: "vendor/\u001b[31mmodel\u0000" },
      }),
    ).toMatchObject({ model: "vendor/model" });
  });

  // #201-T01
  it("is in the detail of a run, redacted, and not in the row of the list", () => {
    const stored = job({
      reviewKind: "dynamic",
      result: { ok: true, commentUrl: null, logTail: "", usage },
    });

    const detail = toRunDetailView(stored, "acme/widgets", NOW, (text) =>
      text.replace("dynamic-model", "[redacted]"),
    );

    expect(detail.usage).toEqual({
      model: "vendor/[redacted]",
      totalTokens: 12900,
      aiCalls: 7,
      costUsd: 0.04,
    });
    expect(toRunRowView(stored, "acme/widgets", NOW)).not.toHaveProperty(
      "usage",
    );
  });
});

describe("the row of a run", () => {
  it("carries what the list shows and nothing of the lease", () => {
    const view = toRunRowView(job(), "acme/widgets", NOW);

    expect(view).toEqual({
      id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
      repositoryId: "repo-1",
      project: "acme/widgets",
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      command: "review",
      reviewKind: "diff",
      triggerKind: "webhook",
      trigger: "Automatic",
      status: "succeeded",
      createdAt: "2026-10-10T12:00:00.000Z",
      startedAt: "2026-10-10T12:00:10.000Z",
      finishedAt: "2026-10-10T12:01:00.000Z",
      durationMs: 50_000,
      problem: null,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain("runner-secret-name");
    expect(text).not.toContain("delivery-1");
  });

  // #200
  it("carries the review kind the run was queued for, in the list and in the detail", () => {
    const dynamic = job({ reviewKind: "dynamic" });

    expect(toRunRowView(dynamic, "p", NOW).reviewKind).toBe("dynamic");
    expect(toRunDetailView(dynamic, "p", NOW).reviewKind).toBe("dynamic");
  });

  // CR-35-T04
  it("names who started a run started by comment or by hand", () => {
    expect(
      toRunRowView(
        job({ triggerKind: "comment", actorLogin: "alice" }),
        "p",
        NOW,
      ).trigger,
    ).toBe("Comment by alice");
    expect(
      toRunRowView(job({ triggerKind: "manual", actorLogin: "bob" }), "p", NOW)
        .trigger,
    ).toBe("Started by bob");
  });

  it("counts a running run up to the time of the answer and shows none for a waiting one", () => {
    expect(
      toRunRowView(job({ status: "running", finishedAt: null }), "p", NOW)
        .durationMs,
    ).toBe(590_000);
    expect(
      toRunRowView(
        job({ status: "queued", claimedAt: null, finishedAt: null }),
        "p",
        NOW,
      ).durationMs,
    ).toBeNull();
  });

  it("explains why a failed or cancelled run did not succeed", () => {
    expect(
      toRunRowView(job({ status: "failed", errorCode: "timeout" }), "p", NOW)
        .problem,
    ).toBe("The run took longer than the time limit, so it was stopped.");
    expect(
      toRunRowView(
        job({ status: "cancelled", errorCode: "project_deactivated" }),
        "p",
        NOW,
      ).problem,
    ).toContain("switched off");
    expect(
      toRunRowView(job({ status: "failed", errorCode: null }), "p", NOW)
        .problem,
    ).toBe("The run failed without saying why.");
    expect(
      toRunRowView(job({ status: "succeeded" }), "p", NOW).problem,
    ).toBeNull();
  });

  it("links the pull request only when it is a github.com address, like the comment link", () => {
    for (const bad of [
      "javascript:alert(1)",
      "https://evil.example/acme/widgets/pull/7",
      "https://evilgithub.com/acme/widgets/pull/7",
      "http://github.com/acme/widgets/pull/7",
    ])
      expect(toRunRowView(job({ prUrl: bad }), "p", NOW).prUrl).toBeNull();
    expect(
      toRunRowView(
        job({ prUrl: "https://github.com/acme/widgets/pull/7" }),
        "p",
        NOW,
      ).prUrl,
    ).toBe("https://github.com/acme/widgets/pull/7");
  });
});

describe("the detail of a run", () => {
  const succeeded = job({
    result: {
      ok: true,
      commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
      logTail: "reviewed 3 files",
      logTruncated: false,
      usage: { model: "m", costUsd: 0.01 },
      errorMessage: null,
    },
  });

  // CR-35-T04
  it("holds pull request, command, trigger, times, comment link and log", () => {
    const view = toRunDetailView(succeeded, "acme/widgets", NOW);

    expect(view).toMatchObject({
      prNumber: 7,
      command: "review",
      trigger: "Automatic",
      startedAt: "2026-10-10T12:00:10.000Z",
      finishedAt: "2026-10-10T12:01:00.000Z",
      durationMs: 50_000,
      commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
      commentMissing: false,
      log: { text: "reviewed 3 files", truncated: false },
      headSha: "a".repeat(40),
    });
  });

  // CR-35-T15
  it("does not carry the runner, the lease, the delivery or the rest of the stored result", () => {
    const text = JSON.stringify(
      toRunDetailView(succeeded, "acme/widgets", NOW),
    );

    for (const secret of [
      "runner-secret-name",
      "delivery-1",
      "leaseExpiresAt",
      "heartbeat",
      // The usage is shown (#201), but only the four fields of `RunUsageView`: the rest of it stays.
      "promptTokens",
      "completionTokens",
      "fallbackUsed",
      "errorMessage",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  // CR-35-T14
  it("gives a run without a usable comment link no link", () => {
    for (const commentUrl of [
      "javascript:alert(1)",
      "https://evil.example/c",
      null,
    ]) {
      const view = toRunDetailView(
        job({ result: { ok: true, commentUrl, logTail: "" } }),
        "p",
        NOW,
      );
      expect(view.commentUrl).toBeNull();
    }
  });

  it("says a succeeded run has no comment link, but not a failed one", () => {
    expect(
      toRunDetailView(job({ result: { ok: true, commentUrl: null } }), "p", NOW)
        .commentMissing,
    ).toBe(true);
    expect(
      toRunDetailView(
        job({ status: "failed", errorCode: "timeout", result: null }),
        "p",
        NOW,
      ).commentMissing,
    ).toBe(false);
  });

  // CR-35-T10
  it("marks a shortened log and an empty one", () => {
    expect(
      toRunDetailView(
        job({ result: { ok: true, logTail: "tail", logTruncated: true } }),
        "p",
        NOW,
      ).log,
    ).toEqual({ text: "tail", truncated: true });
    expect(toRunDetailView(job({ result: null }), "p", NOW).log).toEqual({
      text: "",
      truncated: false,
    });
  });

  it("keeps the end of a log that is longer than the limit and says it was shortened", () => {
    const long = `${"a".repeat(MAX_LOG_CHARS)}END`;

    const { log } = toRunDetailView(
      job({ result: { ok: true, logTail: long } }),
      "p",
      NOW,
    );

    expect(log.text).toHaveLength(MAX_LOG_CHARS);
    expect(log.text.endsWith("END")).toBe(true);
    expect(log.truncated).toBe(true);
  });

  it("hands the log to the redaction before it leaves", () => {
    const { log } = toRunDetailView(
      job({ result: { ok: true, logTail: "key sk-live-123 used" } }),
      "p",
      NOW,
      (text) => text.replace("sk-live-123", "[redacted]"),
    );

    expect(log.text).toBe("key [redacted] used");
  });

  // CR-35-T09
  it("shows an unknown error code with the general sentence", () => {
    const view = toRunDetailView(
      job({ status: "failed", errorCode: "brand_new_problem" }),
      "p",
      NOW,
    );

    expect(view.errorCode).toBe("brand_new_problem");
    expect(view.errorCodeKnown).toBe(false);
    expect(view.problem).toBe(UNKNOWN_ERROR_COPY);
  });

  // CR-53-T01
  it.each([
    [
      "review_state_truncated",
      "The review was posted, but it grew past GitHub's comment size limit, so earlier findings are no longer tracked.",
    ],
    [
      "review_text_truncated",
      "The review was posted, but part of it was cut off because the comment reached GitHub's size limit.",
    ],
  ])(
    "explains %s in words and keeps the link to the review that was posted",
    (errorCode, sentence) => {
      const commentUrl =
        "https://github.com/acme/widgets/pull/7#issuecomment-9";
      const view = toRunDetailView(
        job({
          status: "failed",
          errorCode,
          result: { ok: false, errorCode, commentUrl, logTail: "" },
        }),
        "p",
        NOW,
      );

      expect(view.status).toBe("failed");
      expect(view.problem).toBe(sentence);
      expect(view.errorCode).toBe(errorCode);
      expect(view.errorCodeKnown).toBe(true);
      expect(view.commentUrl).toBe(commentUrl);
      expect(view.commentMissing).toBe(false);
    },
  );

  // CR-53-T03
  it("shows no comment link for other failed runs, even if the stored result has one", () => {
    const view = toRunDetailView(
      job({
        status: "failed",
        errorCode: "llm_auth",
        result: {
          ok: false,
          errorCode: "llm_auth",
          commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
          logTail: "",
        },
      }),
      "p",
      NOW,
    );

    expect(view.commentUrl).toBeNull();
  });

  // CR-53-T03
  it("gives a truncated review whose link is not usable no link and no claim that it is missing", () => {
    const view = toRunDetailView(
      job({
        status: "failed",
        errorCode: "review_state_truncated",
        result: { ok: false, commentUrl: null, logTail: "" },
      }),
      "p",
      NOW,
    );

    expect(view.commentUrl).toBeNull();
    expect(view.commentMissing).toBe(false);
  });

  it("keeps a question and a replaced run's successor", () => {
    const view = toRunDetailView(
      job({
        command: "ask",
        args: "What does it do?\u001b[0m",
        status: "superseded",
        supersededBy: "next-job",
        claimedAt: null,
        finishedAt: null,
      }),
      "p",
      NOW,
    );

    expect(view.args).toBe("What does it do?");
    expect(view.supersededBy).toBe("next-job");
  });
});
