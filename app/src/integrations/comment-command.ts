// Reads a comment on a pull request as a command. The text of a comment is untrusted input: only the
// command word and (for /ask) the question are taken from it, and the question is cut to a fixed
// length. Nothing here knows which git platform the comment came from.
import type { ReviewCommand } from "./types.ts";

/** The longest `/ask` question a job carries (decision of the project lead); longer ones are cut. */
export const ASK_QUESTION_MAX_CHARS = 2000;

/**
 * Appended to a cut question, so the model (and a reader of the job) knows the text ends early. It
 * is part of the job's arguments; with the question it stays well inside the runner contract's
 * limit for the question.
 */
export const ASK_QUESTION_TRUNCATION_NOTE = `[Note: the question was longer than ${ASK_QUESTION_MAX_CHARS} characters and was cut here.]`;

export type ParsedCommentCommand = {
  command: ReviewCommand;
  /** The question for `ask`; always an empty string for the other commands. */
  args: string;
};

// A command counts only if the comment starts with it (whitespace before it is allowed), in any case.
// The word must end there: `/reviewer` and `/review-all` are not `/review`.
const COMMAND_PATTERN =
  /^\s*\/(review|improve|describe|ask)(?=\s|$)([\s\S]*)$/i;

function cutToLength(question: string): string {
  // Count code points, not UTF-16 units, so an emoji is never cut in half.
  const characters = Array.from(question);
  if (characters.length <= ASK_QUESTION_MAX_CHARS) return question;
  return `${characters.slice(0, ASK_QUESTION_MAX_CHARS).join("")}\n\n${ASK_QUESTION_TRUNCATION_NOTE}`;
}

/**
 * The command a comment asks for, or `null` when the comment is no command: it does not start with
 * one, the word is an unknown one, or `/ask` has no question.
 *
 * Only `/ask` takes text. For the other commands PR-Agent would read text after the command as
 * options (`/review --setting=value`), so it is dropped here and never reaches a job.
 */
export function parseCommentCommand(body: string): ParsedCommentCommand | null {
  const match = COMMAND_PATTERN.exec(body);
  if (match === null) return null;
  const command = (match[1] as string).toLowerCase() as ReviewCommand;
  if (command !== "ask") return { command, args: "" };
  const question = (match[2] ?? "").trim();
  if (question === "") return null;
  return { command, args: cutToLength(question) };
}
