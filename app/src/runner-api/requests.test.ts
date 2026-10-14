// SPDX-License-Identifier: Apache-2.0

// Pins down the checks on what a runner sends: the job id in the path, the runner id header and the
// bodies of heartbeat and complete. A refusal names fields and reasons, never the values.
import { describe, expect, it } from "vitest";
import {
  parseCompleteRequest,
  parseHeartbeatRequest,
  parseJobId,
  parseRunnerId,
} from "./requests.ts";

const TOKEN = "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33";
const GOOD_RESULT = {
  ok: true,
  durationMs: 41250,
  commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1001",
  errorCode: null,
  logTail: "review published",
  logTruncated: false,
  usage: {
    model: "vendor/model-name",
    promptTokens: 12000,
    completionTokens: 900,
    totalTokens: 12900,
    aiCalls: 2,
    fallbackUsed: false,
    costUsd: 0.04,
  },
};

function fieldsOf(result: ReturnType<typeof parseCompleteRequest>) {
  if (result.ok) throw new Error("expected a refusal");
  return result.fields;
}

describe("the job id in the path", () => {
  it("accepts a UUID", () => {
    expect(parseJobId("0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10")).toBe(true);
  });

  it.each([
    "",
    "abc",
    "0b9f6f4e",
    "../etc/passwd",
    "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b1g",
    " 0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10",
  ])("refuses %j", (id) => {
    expect(parseJobId(id)).toBe(false);
  });
});

describe("the runner id header", () => {
  it("passes a plain id through", () => {
    expect(parseRunnerId("runner-1.local:2")).toStrictEqual({
      ok: true,
      value: "runner-1.local:2",
    });
  });

  it("uses a fixed name for a request without the header", () => {
    expect(parseRunnerId(null)).toStrictEqual({ ok: true, value: "unknown" });
  });

  it.each([
    "",
    "   ",
    "a".repeat(65),
    "runner one",
    "runner\nid",
    "run;ner",
    "ünicode",
  ])("refuses %j, so nothing odd reaches the logs or the table", (id) => {
    expect(parseRunnerId(id).ok).toBe(false);
  });
});

describe("the heartbeat body", () => {
  it("accepts a lease token and ignores fields it does not know", () => {
    expect(
      parseHeartbeatRequest({ leaseToken: TOKEN, extra: 1 }),
    ).toStrictEqual({ ok: true, value: { leaseToken: TOKEN } });
  });

  it.each([
    ["not an object", "text"],
    ["null", null],
    ["an array", []],
    ["no token", {}],
    ["a token that is not text", { leaseToken: 5 }],
    ["a token that is too short", { leaseToken: "short" }],
    ["a token that is too long", { leaseToken: "x".repeat(257) }],
  ])("refuses %s", (_name, body) => {
    expect(parseHeartbeatRequest(body).ok).toBe(false);
  });
});

describe("the complete body", () => {
  it("accepts a successful result and fills in what was left out", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ok: true, durationMs: 5, errorCode: null, logTail: "" },
    });

    expect(parsed).toStrictEqual({
      ok: true,
      value: {
        leaseToken: TOKEN,
        result: {
          ok: true,
          durationMs: 5,
          commentUrl: null,
          errorCode: null,
          errorMessage: null,
          logTail: "",
          logTruncated: false,
          usage: null,
        },
      },
    });
  });

  it("keeps every field of a full result and drops fields it does not know", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, somethingNew: "x" },
    });

    expect(parsed.ok && parsed.value.result).toStrictEqual({
      ...GOOD_RESULT,
      errorMessage: null,
    });
  });

  it("accepts a failed result with an error code and a message", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: {
        ok: false,
        durationMs: 10,
        errorCode: "llm_auth",
        errorMessage: "The key was refused.",
        logTail: "401",
      },
    });

    expect(parsed.ok && parsed.value.result.errorMessage).toBe(
      "The key was refused.",
    );
  });

  // #296-T10
  it("keeps the stable reason of a failure and leaves the field out when there is none", () => {
    const failed = {
      ok: false,
      durationMs: 10,
      errorCode: "checkout_incomplete",
      errorReason: "budget_preparation",
      logTail: "checkout_incomplete [budget_preparation]",
    };
    const parsed = parseCompleteRequest({ leaseToken: TOKEN, result: failed });

    expect(parsed.ok && parsed.value.result.errorReason).toBe(
      "budget_preparation",
    );
    const plain = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...failed, errorReason: undefined },
    });
    expect(plain.ok && "errorReason" in plain.value.result).toBe(false);
  });

  // #296-T10
  it.each(["Budget Prep", "", "../etc", 5, ["a"]])(
    "refuses a reason that is not a stable name (%j)",
    (errorReason) => {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ok: false,
          durationMs: 1,
          errorCode: "checkout_incomplete",
          errorReason,
          logTail: "",
        },
      });

      expect(fieldsOf(parsed)).toStrictEqual([
        { field: "result.errorReason", code: "invalid" },
      ]);
    },
  );

  // #296-T10
  it("refuses a reason that is longer than a stable name", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: {
        ok: false,
        durationMs: 1,
        errorCode: "checkout_incomplete",
        errorReason: "x".repeat(65),
        logTail: "",
      },
    });

    expect(fieldsOf(parsed)).toStrictEqual([
      { field: "result.errorReason", code: "too_long" },
    ]);
  });

  it("refuses a failed result without an error code and a good one with one", () => {
    const failed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, ok: false },
    });
    const good = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, errorCode: "timeout" },
    });

    expect(fieldsOf(failed)).toContainEqual({
      field: "result.errorCode",
      code: "invalid",
    });
    expect(fieldsOf(good)).toContainEqual({
      field: "result.errorCode",
      code: "invalid",
    });
  });

  it.each([
    ["a code in capitals", "TIMEOUT"],
    ["a code with a space", "time out"],
    ["a code that starts with a digit", "1abc"],
    ["a code that is too long", "a".repeat(65)],
  ])("refuses %s as an error code", (_name, code) => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, ok: false, errorCode: code },
    });

    expect(fieldsOf(parsed)).toContainEqual({
      field: "result.errorCode",
      code: "invalid",
    });
  });

  // #267-T07
  it("keeps the exact small cost of a Dynamic Review as the runner wrote it", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: {
        ...GOOD_RESULT,
        usage: { ...GOOD_RESULT.usage, costUsd: 5.79e-5 },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.result.usage?.costUsd).toBe(5.79e-5);
    expect(parsed.value.result.usage?.costUsd).toBe(
      JSON.parse('{"costUsd":5.79e-05}').costUsd,
    );
  });

  // #267-T07
  it("refuses a cost that is not a finite number of at least zero", () => {
    for (const costUsd of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      -0.01,
      "0.01",
      true,
    ]) {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ...GOOD_RESULT,
          usage: { ...GOOD_RESULT.usage, costUsd },
        },
      });

      expect(fieldsOf(parsed)).toContainEqual({
        field: "result.usage.costUsd",
        code: "invalid",
      });
    }
  });

  it("names every field that is missing or wrong, once each, without echoing values", () => {
    const parsed = parseCompleteRequest({
      leaseToken: "short",
      result: {
        ok: "yes",
        durationMs: -1,
        errorCode: null,
        logTail: 5,
        usage: { model: 5 },
      },
    });

    const fields = fieldsOf(parsed);
    expect(fields).toContainEqual({ field: "leaseToken", code: "invalid" });
    expect(fields).toContainEqual({ field: "result.ok", code: "invalid" });
    expect(fields).toContainEqual({
      field: "result.durationMs",
      code: "invalid",
    });
    expect(fields).toContainEqual({ field: "result.logTail", code: "invalid" });
    expect(fields).toContainEqual({
      field: "result.usage.model",
      code: "invalid",
    });
    expect(fields).toContainEqual({
      field: "result.usage.promptTokens",
      code: "required",
    });
    expect(JSON.stringify(fields)).not.toContain("yes");
  });

  it("marks text over its limit as too long", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, logTail: "x".repeat(8193) },
    });

    expect(fieldsOf(parsed)).toContainEqual({
      field: "result.logTail",
      code: "too_long",
    });
  });

  it.each([
    ["no result", { leaseToken: TOKEN }],
    ["a result that is not an object", { leaseToken: TOKEN, result: "ok" }],
    ["no lease token", { result: GOOD_RESULT }],
  ])("refuses %s", (_name, body) => {
    expect(parseCompleteRequest(body).ok).toBe(false);
  });

  it("refuses a comment URL that is not a web address", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, commentUrl: "javascript:alert(1)" },
    });

    expect(fieldsOf(parsed)).toContainEqual({
      field: "result.commentUrl",
      code: "invalid",
    });
  });
});
