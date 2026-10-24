// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down which bodies may start a review by hand: since #203 the only command is `/review`, and
// it takes no text. Every problem is reported per field, and a supplied question is refused (not
// ignored) with a value-free code.
import { describe, expect, it } from "vitest";
import { validateStartInput } from "./start-input.ts";

describe("the body that starts a review", () => {
  // #203-T05
  it("accepts /review without any question", () => {
    expect(validateStartInput({ prNumber: 7, command: "review" })).toEqual({
      ok: true,
      value: { prNumber: 7, command: "review" },
    });
  });

  // #203-T05
  it("refuses a supplied question, whatever it holds", () => {
    for (const question of ["why?", "", "   ", 5, null]) {
      expect(
        validateStartInput({ prNumber: 7, command: "review", question }),
        String(question),
      ).toEqual({
        ok: false,
        issues: [{ field: "question", code: "invalid" }],
      });
    }
  });

  // #203-T05
  it.each(["ask", "improve", "describe"])(
    "refuses the removed command %s",
    (command) => {
      expect(validateStartInput({ prNumber: 7, command })).toEqual({
        ok: false,
        issues: [{ field: "command", code: "invalid" }],
      });
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
    const result = validateStartInput({
      prNumber: "abc",
      command: "ask",
      question: "why?",
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        { field: "prNumber", code: "invalid" },
        { field: "command", code: "invalid" },
        { field: "question", code: "invalid" },
      ],
    });
  });

  it.each([null, "text", 5, [], undefined])(
    "refuses a body that is not an object (%s)",
    (body) => {
      expect(validateStartInput(body)).toMatchObject({ ok: false });
    },
  );
});
