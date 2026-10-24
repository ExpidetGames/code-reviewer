// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down which input the queue accepts: the checks run before anything is written, and every
// refusal names the field and a stable code.
import { describe, expect, it } from "vitest";
import { validateEnqueueInput } from "./job-input.ts";
import type { EnqueueJobInput } from "./job-types.ts";

const SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

function input(overrides: Record<string, unknown> = {}): EnqueueJobInput {
  return {
    repositoryId: "repo-1",
    prNumber: 7,
    prUrl: "https://github.test/acme/widgets/pull/7",
    headSha: SHA,
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
    ...overrides,
  } as EnqueueJobInput;
}

describe("validating a job to enqueue", () => {
  it("accepts a complete input and fills in the defaults", () => {
    const result = validateEnqueueInput(input());

    expect(result).toEqual({
      ok: true,
      value: {
        repositoryId: "repo-1",
        prNumber: 7,
        prUrl: "https://github.test/acme/widgets/pull/7",
        headSha: SHA,
        reviewKind: undefined,
        command: "review",
        args: "",
        triggerKind: "webhook",
        actorLogin: "octocat",
        deliveryId: null,
        commentId: null,
        runAfter: null,
      },
    });
  });

  // CR-27-T12
  it.each([
    ["too short", "abc123"],
    ["39 characters", SHA.slice(0, 39)],
    ["41 characters", `${SHA}0`],
    ["not hexadecimal", "z".repeat(40)],
    ["empty", ""],
  ])("refuses a head commit that is %s", (_name, headSha) => {
    expect(validateEnqueueInput(input({ headSha }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "headSha", code: "invalid" }],
    });
  });

  it("accepts an upper-case head commit and stores it in lower case", () => {
    const result = validateEnqueueInput(input({ headSha: SHA.toUpperCase() }));

    expect(result).toMatchObject({ ok: true, value: { headSha: SHA } });
  });

  // CR-27-T12, #203-T02
  it.each([
    ["empty", "", "required"],
    ["unknown", "deploy", "invalid"],
    ["the removed ask command", "ask", "invalid"],
    ["the removed improve command", "improve", "invalid"],
    ["the removed describe command", "describe", "invalid"],
    ["wrongly cased", "Review", "invalid"],
    ["missing", undefined, "required"],
  ])("refuses a command that is %s", (_name, command, code) => {
    expect(validateEnqueueInput(input({ command }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "command", code }],
    });
  });

  it("reports every invalid field at once", () => {
    const result = validateEnqueueInput(
      input({ headSha: "x", command: "", prNumber: 0, actorLogin: "" }),
    );

    expect(result).toEqual({
      ok: false,
      fieldErrors: [
        { field: "prNumber", code: "invalid" },
        { field: "headSha", code: "invalid" },
        { field: "command", code: "required" },
        { field: "actorLogin", code: "required" },
      ],
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "7"])(
    "refuses the pull request number %s",
    (prNumber) => {
      expect(validateEnqueueInput(input({ prNumber }))).toEqual({
        ok: false,
        fieldErrors: [{ field: "prNumber", code: "invalid" }],
      });
    },
  );

  it("refuses a pull request URL that is not an http(s) URL", () => {
    expect(
      validateEnqueueInput(input({ prUrl: "javascript:alert(1)" })),
    ).toEqual({
      ok: false,
      fieldErrors: [{ field: "prUrl", code: "invalid" }],
    });
    expect(validateEnqueueInput(input({ prUrl: "" }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "prUrl", code: "required" }],
    });
  });

  it("refuses a trigger kind that does not exist", () => {
    expect(validateEnqueueInput(input({ triggerKind: "cron" }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "triggerKind", code: "invalid" }],
    });
  });

  // #195: the review kind a job carries is decided at enqueue time; a producer that names an unknown
  // one is refused, and leaving it out lets the queue resolve it inside the enqueue transaction.
  it("accepts a known or absent review kind and refuses an unknown one", () => {
    expect(
      validateEnqueueInput(input({ reviewKind: "dynamic" })),
    ).toMatchObject({ ok: true, value: { reviewKind: "dynamic" } });
    expect(validateEnqueueInput(input())).toMatchObject({
      ok: true,
      value: { reviewKind: undefined },
    });
    expect(validateEnqueueInput(input({ reviewKind: "agentic" }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "reviewKind", code: "invalid" }],
    });
  });

  // #203: /review takes no text; non-empty arguments would name a duplicate job that runs the same
  // review, so every non-empty argument is refused.
  it("refuses non-empty review arguments and arguments that are not text", () => {
    expect(validateEnqueueInput(input({ args: "first" }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "args", code: "invalid" }],
    });
    expect(
      validateEnqueueInput(input({ args: "--pr_reviewer.num_max_findings=9" })),
    ).toEqual({
      ok: false,
      fieldErrors: [{ field: "args", code: "invalid" }],
    });
    expect(validateEnqueueInput(input({ args: 5 }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "args", code: "invalid" }],
    });
    expect(validateEnqueueInput(input({ args: "" }))).toMatchObject({
      ok: true,
      value: { args: "" },
    });
  });

  it("refuses an empty delivery id but accepts none", () => {
    expect(validateEnqueueInput(input({ deliveryId: "" }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "deliveryId", code: "invalid" }],
    });
    expect(validateEnqueueInput(input({ deliveryId: null }))).toMatchObject({
      ok: true,
    });
  });

  it("refuses an empty comment id but accepts none", () => {
    expect(validateEnqueueInput(input({ commentId: "" }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "commentId", code: "invalid" }],
    });
    expect(validateEnqueueInput(input({ commentId: 99001 }))).toEqual({
      ok: false,
      fieldErrors: [{ field: "commentId", code: "invalid" }],
    });
    expect(validateEnqueueInput(input({ commentId: null }))).toMatchObject({
      ok: true,
    });
    expect(validateEnqueueInput(input({ commentId: "99001" }))).toMatchObject({
      ok: true,
      value: { commentId: "99001" },
    });
  });

  it("refuses a run-after that is not a valid date", () => {
    expect(validateEnqueueInput(input({ runAfter: new Date("nope") }))).toEqual(
      {
        ok: false,
        fieldErrors: [{ field: "runAfter", code: "invalid" }],
      },
    );
  });
});
