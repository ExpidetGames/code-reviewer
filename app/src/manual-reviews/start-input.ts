// Checks the body that starts a review by hand. The values come from the browser, so nothing here
// trusts a type: every field is looked at as `unknown`. Only `ask` takes text; for the other
// commands PR-Agent would read text after the command as options, so it never reaches a job.
import {
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTION_RAW_MAX_CHARS,
  removeImageLinks,
} from "../integrations/comment-command.ts";
import { REVIEW_COMMANDS, type ReviewCommand } from "../integrations/types.ts";
import type { ManualReviewIssue } from "./errors.ts";

export type StartInput = {
  prNumber: number;
  command: ReviewCommand;
  /** The question of `ask`, trimmed and without image links; an empty string for every other command. */
  question: string;
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
    issues.push({ field: "command", code: "invalid" });

  let question = "";
  if (command === "ask") {
    const written = fields.question;
    if (written === undefined)
      issues.push({ field: "question", code: "required" });
    else if (typeof written !== "string")
      issues.push({ field: "question", code: "invalid" });
    else if (written.trim() === "")
      issues.push({ field: "question", code: "required" });
    // Looked at before the images are removed only so a hostile body is not chewed on at length.
    else if (written.trim().length > ASK_QUESTION_RAW_MAX_CHARS)
      issues.push({ field: "question", code: "too_long" });
    else {
      // The limit counts what the job carries: every image link grows to the placeholder text, so
      // the length is checked after they are replaced, not before.
      const cleaned = removeImageLinks(written.trim()).trim();
      if (cleaned.length > ASK_QUESTION_MAX_CHARS)
        issues.push({ field: "question", code: "too_long" });
      else question = cleaned;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  // The checks above narrowed the fields; the casts only restate what they proved.
  return {
    ok: true,
    value: {
      prNumber: prNumber as number,
      command: command as ReviewCommand,
      question,
    },
  };
}
