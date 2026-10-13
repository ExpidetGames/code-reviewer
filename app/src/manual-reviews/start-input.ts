// SPDX-License-Identifier: Apache-2.0

// Checks the body that starts a review by hand. The values come from the browser, so nothing here
// trusts a type: every field is looked at as `unknown`. Since #203 only `/review` exists; it takes
// no text, and a body that still supplies a `question` (an old client, or a removed ask command) is
// refused with a value-free field code.
import { REVIEW_COMMANDS, type ReviewCommand } from "../integrations/types.ts";
import type { ManualReviewIssue } from "./errors.ts";

export type StartInput = {
  prNumber: number;
  command: ReviewCommand;
};

export type StartInputCheck =
  { ok: true; value: StartInput } | { ok: false; issues: ManualReviewIssue[] };

export function validateStartInput(body: unknown): StartInputCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return {
      ok: false,
      issues: [
        { field: "prNumber", code: "required" },
        { field: "command", code: "required" },
      ],
    };
  const fields = body as Record<string, unknown>;
  const issues: ManualReviewIssue[] = [];

  const prNumber = fields.prNumber;
  if (prNumber === undefined)
    issues.push({ field: "prNumber", code: "required" });
  else if (
    typeof prNumber !== "number" ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1
  )
    issues.push({ field: "prNumber", code: "invalid" });

  const command = fields.command;
  if (command === undefined || command === "")
    issues.push({ field: "command", code: "required" });
  else if (!REVIEW_COMMANDS.some((known) => known === command))
    // An unknown command and a removed one (`ask`, `improve`, `describe`) are both invalid.
    issues.push({ field: "command", code: "invalid" });

  // `/review` takes no text. A supplied `question` is refused instead of ignored, so it never
  // reaches a job; the code names the field, never the value.
  if (fields.question !== undefined)
    issues.push({ field: "question", code: "invalid" });

  if (issues.length > 0) return { ok: false, issues };
  // The checks above narrowed the fields; the casts only restate what they proved.
  return {
    ok: true,
    value: {
      prNumber: prNumber as number,
      command: command as ReviewCommand,
    },
  };
}
