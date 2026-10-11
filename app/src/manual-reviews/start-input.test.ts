// SPDX-License-Identifier: Apache-2.0

// Pins down which bodies may start a review by hand: the pull request number, the command and, for
// `ask`, a question. Every problem is reported per field, and a question is cleaned like one written
// in a comment (no image links).
import { describe, expect, it } from "vitest";
import {
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTION_RAW_MAX_CHARS,
} from "../integrations/comment-command.ts";
import { validateStartInput } from "./start-input.ts";

describe("the body that starts a review", () => {
  it("accepts a command without a question and ignores a question that was sent along", () => {
    expect(
      validateStartInput({ prNumber: 7, command: "review", question: "why?" }),
    ).toEqual({
      ok: true,
      value: { prNumber: 7, command: "review", question: "" },
    });
  });

  it.each(["review", "improve", "describe", "ask"])(
    "knows the command %s",
    (command) => {
      const result = validateStartInput({
        prNumber: 1,
        command,
        question: "How does this work?",
      });

      expect(result.ok).toBe(true);
    },
  );

  // CR-33-T14
  it.each([
    ["abc", "invalid"],
    ["7", "invalid"],
    [-1, "invalid"],
    [0, "invalid"],
    [1.5, "invalid"],
    [Number.MAX_SAFE_INTEGER + 1, "invalid"],
    [null, "invalid"],
    [undefined, "required"],
  ] as const)("refuses the pull request number %s", (prNumber, code) => {
    const result = validateStartInput({ prNumber, command: "review" });

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "prNumber", code }],
    });
  });

  // CR-33-T14
  it.each([
    ["deploy", "invalid"],
    ["REVIEW", "invalid"],
    ["", "required"],
    [undefined, "required"],
    [5, "invalid"],
  ] as const)("refuses the command %s", (command, code) => {
    const result = validateStartInput({ prNumber: 7, command });

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "command", code }],
    });
  });

  it("reports every unusable field at once", () => {
    const result = validateStartInput({ prNumber: "abc", command: "deploy" });

    expect(result).toEqual({
      ok: false,
      issues: [
        { field: "prNumber", code: "invalid" },
        { field: "command", code: "invalid" },
      ],
    });
  });

  it.each([null, "text", 5, [], undefined])(
    "refuses a body that is not an object (%s)",
    (body) => {
      expect(validateStartInput(body)).toMatchObject({ ok: false });
    },
  );

  // CR-33-T06
  it.each([undefined, "", "   ", "\n\t "])(
    "refuses an ask without a question (%j)",
    (question) => {
      const result = validateStartInput({
        prNumber: 7,
        command: "ask",
        question,
      });

      expect(result).toEqual({
        ok: false,
        issues: [{ field: "question", code: "required" }],
      });
    },
  );

  it("refuses a question that is not text", () => {
    const result = validateStartInput({
      prNumber: 7,
      command: "ask",
      question: 5,
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "question", code: "invalid" }],
    });
  });

  it("refuses a question over the limit instead of cutting it", () => {
    const result = validateStartInput({
      prNumber: 7,
      command: "ask",
      question: "x".repeat(ASK_QUESTION_MAX_CHARS + 1),
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "question", code: "too_long" }],
    });
  });

  it("refuses a question that is within the limit as written but grows past it once its image links are replaced", () => {
    const written = "![]".repeat(666);
    expect(written.length).toBeLessThanOrEqual(ASK_QUESTION_MAX_CHARS);

    const result = validateStartInput({
      prNumber: 7,
      command: "ask",
      question: written,
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "question", code: "too_long" }],
    });
  });

  it("keeps a question that shrinks below the limit once its long image links are replaced", () => {
    const written = `Is https://evil.test/${"a".repeat(2500)}.png fine?`;

    const result = validateStartInput({
      prNumber: 7,
      command: "ask",
      question: written,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        prNumber: 7,
        command: "ask",
        question: "Is [image link removed] fine?",
      },
    });
  });

  it("refuses a question far over the limit without looking at it", () => {
    const result = validateStartInput({
      prNumber: 7,
      command: "ask",
      question: "x".repeat(ASK_QUESTION_RAW_MAX_CHARS + 1),
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ field: "question", code: "too_long" }],
    });
  });

  it("trims a question and keeps one of exactly the limit", () => {
    const result = validateStartInput({
      prNumber: 7,
      command: "ask",
      question: `  ${"x".repeat(ASK_QUESTION_MAX_CHARS)}  `,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        prNumber: 7,
        command: "ask",
        question: "x".repeat(ASK_QUESTION_MAX_CHARS),
      },
    });
  });

  it("replaces image links in a question, so the runner is never made to fetch them", () => {
    const result = validateStartInput({
      prNumber: 7,
      command: "ask",
      question: "Is ![x](http://169.254.169.254/latest/) fine?",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        prNumber: 7,
        command: "ask",
        question: "Is [image link removed] fine?",
      },
    });
  });
});
