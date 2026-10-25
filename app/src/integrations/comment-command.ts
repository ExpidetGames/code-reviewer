// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads a comment on a pull request as a command. The text of a comment is untrusted input: only the
// command word is taken from it; any text after the command is dropped, because PR-Agent would read
// it as options (`/review --setting=value`). Nothing here knows which git platform the comment came
// from.
//
// Since #203 only `/review` is a command. A comment that starts with `/ask`, `/improve` or
// `/describe` is an ordinary comment: it returns null, exactly like a comment with no command, and
// no command-not-allowed answer, job, credential or model call follows.
import type { ReviewCommand } from "./types.ts";

export type ParsedCommentCommand = {
  command: ReviewCommand;
  /** Always an empty string: `/review` takes no text. */
  args: string;
};

// A command counts only if the comment starts with it (whitespace before it is allowed), in any case.
// The word must end there: `/reviewer` and `/review-all` are not `/review`.
const COMMAND_PATTERN = /^\s*\/(review)(?=\s|$)/i;

/**
 * The command a comment asks for, or `null` when the comment is no command: it does not start with
 * one, or the word is an unknown or removed one. Only `/review` counts, and it takes no text.
 */
export function parseCommentCommand(body: string): ParsedCommentCommand | null {
  const match = COMMAND_PATTERN.exec(body);
  if (match === null) return null;
  const command = (match[1] as string).toLowerCase() as ReviewCommand;
  return { command, args: "" };
}
