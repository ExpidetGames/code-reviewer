// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { JOB_ERROR_CODES } from "../jobs/job-types.ts";
import {
  RUNNER_CHECKOUT_REASONS,
  RUNNER_ERROR_CODES,
} from "../runner-api/contract.ts";
import {
  LAUNCH_FAILED_CODE,
  WORKER_EXITED_CODE,
} from "../runner-api/release.ts";
import { readContract } from "../test-support/runner-contract.ts";
import {
  NO_RESULT_ERROR_REASONS,
  SETTLED_REASONS,
} from "../usage/usage-records.ts";
import {
  CHECKOUT_REASON_CLASSES,
  ERROR_CODE_CLASSES,
  OURS_ON_MANAGED_KEY,
  OUTCOME_CLASSES,
  RESULT_REASON_CLASSES,
  SETTLED_REASON_CLASSES,
  classifyOutcome,
  type OutcomeClass,
  type RunEnd,
} from "./outcome.ts";

const failed = (
  errorCode: string | null,
  rest: Partial<RunEnd> = {},
): RunEnd => ({ status: "failed", errorCode, keyMode: "managed", ...rest });

describe("every terminal code has an outcome class", () => {
  // #494-T08
  it("classes the job end codes of the queue", () => {
    for (const code of JOB_ERROR_CODES)
      expect(OUTCOME_CLASSES, code).toContain(ERROR_CODE_CLASSES[code]);
  });

  // #494-T08
  it("classes the reasons a Dispatcher gives a job back, in the app and in the contract", () => {
    const listed = readContract().$defs.KnownReleaseReason?.enum ?? [];

    expect([LAUNCH_FAILED_CODE, WORKER_EXITED_CODE].sort()).toStrictEqual(
      [...listed].sort(),
    );
    for (const code of listed)
      expect(OUTCOME_CLASSES, String(code)).toContain(
        ERROR_CODE_CLASSES[code as keyof typeof ERROR_CODE_CLASSES],
      );
  });

  // #494-T08
  it("classes every error code of the runner contract", () => {
    const listed = readContract().$defs.KnownRunnerErrorCode?.enum ?? [];

    expect([...RUNNER_ERROR_CODES].sort()).toStrictEqual([...listed].sort());
    for (const code of listed)
      expect(OUTCOME_CLASSES, String(code)).toContain(
        ERROR_CODE_CLASSES[code as keyof typeof ERROR_CODE_CLASSES],
      );
  });

  // #494-T08
  it("classes every checkout reason of the runner contract", () => {
    const listed = readContract().$defs.KnownCheckoutReason?.enum ?? [];

    expect([...RUNNER_CHECKOUT_REASONS].sort()).toStrictEqual(
      [...listed].sort(),
    );
    for (const reason of listed)
      expect(OUTCOME_CLASSES, String(reason)).toContain(
        CHECKOUT_REASON_CLASSES[reason as keyof typeof CHECKOUT_REASON_CLASSES],
      );
  });

  // #494-T08
  it("classes every reason the loop of a runner gives for a run it had to end", () => {
    for (const reason of NO_RESULT_ERROR_REASONS)
      expect(OUTCOME_CLASSES, reason).toContain(
        RESULT_REASON_CLASSES[reason as keyof typeof RESULT_REASON_CLASSES],
      );
  });

  // #494-T08
  it("classes every settled reason of a usage record", () => {
    for (const reason of SETTLED_REASONS)
      expect(OUTCOME_CLASSES, reason).toContain(SETTLED_REASON_CLASSES[reason]);
  });

  // #494-T08
  it("keeps no entry in a table for a code that no list names", () => {
    const known = new Set<string>([
      ...JOB_ERROR_CODES,
      ...RUNNER_ERROR_CODES,
      LAUNCH_FAILED_CODE,
      WORKER_EXITED_CODE,
    ]);
    for (const code of Object.keys(ERROR_CODE_CLASSES))
      expect(known.has(code), code).toBe(true);
    const reasons = new Set<string>(RUNNER_CHECKOUT_REASONS);
    for (const reason of Object.keys(CHECKOUT_REASON_CLASSES))
      expect(reasons.has(reason), reason).toBe(true);
    for (const code of OURS_ON_MANAGED_KEY)
      expect(Object.keys(ERROR_CODE_CLASSES), code).toContain(code);
  });
});

describe("the class of a run's end", () => {
  // The initial split follows ADR 0006, 2.6; the maintainer decided 2026-10-19 (#489) that a run which ends without a
  // result but already incurred AI cost bills its minutes only.
  // #494-T06
  it.each([
    ["launch_failed", "free"],
    ["worker_exited", "free"],
    ["lease_expired", "free"],
    ["lease_lost", "free"],
    ["runner_shutdown", "free"],
    ["dispatch_unavailable", "free"],
    ["dynamic_engine_unavailable", "free"],
    ["dynamic_isolation_self_check_failed", "free"],
    ["dynamic_accounting_failed", "free"],
    ["runner_error", "free"],
    ["invalid_job", "free"],
    ["git_unavailable", "free"],
    ["llm_unavailable", "free"],
  ] as Array<[string, OutcomeClass]>)(
    "bills nothing for %s, an error on our side",
    (code, expected) => {
      expect(classifyOutcome(failed(code))).toBe(expected);
    },
  );

  // #494-T04
  it.each([
    ["timeout", "minutes_only"],
    ["review_not_published", "minutes_only"],
    ["llm_output_invalid", "minutes_only"],
    ["llm_timeout", "minutes_only"],
    ["unknown", "minutes_only"],
  ] as Array<[string, OutcomeClass]>)(
    "bills the minutes only for %s, a run that ended without a result",
    (code, expected) => {
      expect(classifyOutcome(failed(code))).toBe(expected);
    },
  );

  // #494-T01
  it.each([
    "dynamic_budget_exceeded",
    "dynamic_policy_violation",
    "dynamic_config_invalid",
    "checkout_incomplete",
    "pr_not_found",
    "llm_context_length_exceeded",
    "review_text_truncated",
    "command_failed",
    "superseded",
  ])("bills AI and minutes for %s, the customer's side of the line", (code) => {
    expect(classifyOutcome(failed(code))).toBe("charged");
  });

  // #494-T01
  it("bills a delivered result", () => {
    expect(
      classifyOutcome({ status: "succeeded", errorCode: null, keyMode: "own" }),
    ).toBe("charged");
  });

  // #494-T06
  it.each([
    "project_deactivated",
    "pull_request_closed",
    "pull_request_draft",
    "review_kind_changed",
    "no_capable_runner",
    "command_removed",
  ])("bills nothing for a job cancelled with %s", (code) => {
    expect(
      classifyOutcome({ status: "cancelled", errorCode: code, keyMode: "own" }),
    ).toBe("free");
  });

  // #494-T06
  it.each([
    "workspace_suspended",
    "quota_exhausted",
    "entitlements_invalid",
    "dynamic_review_disabled",
  ])("bills nothing for a job refused at claim with %s", (code) => {
    expect(classifyOutcome(failed(code))).toBe("free");
  });

  // #494-T06
  it.each(["llm_auth", "llm_quota", "model_unknown"])(
    "makes %s ours on the managed key and the customer's on their own",
    (code) => {
      expect(classifyOutcome(failed(code, { keyMode: "managed" }))).toBe(
        "free",
      );
      expect(classifyOutcome(failed(code, { keyMode: "own" }))).toBe("charged");
    },
  );

  // #494-T07
  it("bills a superseded run: the table gives it AI and minutes", () => {
    expect(
      classifyOutcome({
        status: "superseded",
        errorCode: null,
        settledReason: "superseded",
        keyMode: "managed",
      }),
    ).toBe("charged");
    expect(
      classifyOutcome({
        status: "superseded",
        errorCode: null,
        keyMode: "own",
      }),
    ).toBe("charged");
  });

  // #494-T04
  it("bills the minutes only for a run settled without a result", () => {
    expect(
      classifyOutcome({
        status: "failed",
        errorCode: "llm_rate_limit",
        settledReason: "no_result",
        keyMode: "managed",
      }),
    ).toBe("free");
    expect(
      classifyOutcome(failed("command_failed", { settledReason: "no_result" })),
    ).toBe("minutes_only");
  });

  // #494-T04
  it("takes the reason of the loop into account: a process that left no usable result", () => {
    expect(
      classifyOutcome(
        failed("command_failed", { errorReason: "no_result_from_process" }),
      ),
    ).toBe("minutes_only");
    expect(
      classifyOutcome(
        failed("runner_error", { errorReason: "unreadable_usage" }),
      ),
    ).toBe("free");
  });

  // #494-T06
  it.each([
    ["invalid_request", "free"],
    ["transport", "free"],
    ["isolation", "free"],
    ["ref_missing", "charged"],
    ["diff_too_large", "charged"],
    ["path_invalid", "charged"],
  ] as Array<[string, OutcomeClass]>)(
    "refines a checkout that failed by its reason %s",
    (reason, expected) => {
      expect(
        classifyOutcome(failed("checkout_incomplete", { errorReason: reason })),
      ).toBe(expected);
    },
  );

  // #494-T08
  it("falls back to the minutes only for a code it does not know, and never throws", () => {
    expect(classifyOutcome(failed("a_code_of_a_newer_runner"))).toBe(
      "minutes_only",
    );
    expect(classifyOutcome(failed(null))).toBe("minutes_only");
    expect(
      classifyOutcome(
        failed("checkout_incomplete", { errorReason: "a_new_reason" }),
      ),
    ).toBe("charged");
  });

  // #494-T08
  it("applies a checkout reason only to a checkout failure", () => {
    expect(
      classifyOutcome(failed("command_failed", { errorReason: "transport" })),
    ).toBe("charged");
  });
});
