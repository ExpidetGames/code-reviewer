// Reads a comment on a pull request as a command. The text of a comment is untrusted input: only the
// command word and (for /ask) the question are taken from it, and the question is cut to a fixed
// length. Nothing here knows which git platform the comment came from.
import type { ReviewCommand } from "./types.ts";

/**
 * The longest `/ask` question a job carries (decision of the project lead); longer ones are cut. It
 * counts UTF-16 units, like the runner API's limit of 4000 for the question, so the cut question
 * and its note always fit that limit, whatever characters it holds.
 */
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
  if (question.length <= ASK_QUESTION_MAX_CHARS) return question;
  let end = ASK_QUESTION_MAX_CHARS;
  // Never cut inside a surrogate pair (an emoji): drop its first half too.
  const last = question.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${question.slice(0, end)}\n\n${ASK_QUESTION_TRUNCATION_NOTE}`;
}

/** What replaces a link to an image. The runner uses the same text (`fakes/fixtures/ask-question-images.json`). */
export const IMAGE_LINK_PLACEHOLDER = "[image link removed]";

// PR-Agent's /ask takes the first markdown image (`![image]`) or the first link that ends in an image
// extension from the question and downloads it from the runner (HEAD request, redirects followed).
// Anybody who may write a command could so make the runner request an address of their choice, so a
// question never carries either of them. The rules are wider than PR-Agent's on purpose: any `![...]`
// with what follows it in brackets or parentheses, and any link that has an image extension anywhere
// (path, query or fragment). The runner repeats this on the question it receives, with PR-Agent's
// own text engine; both must give the results in the shared fixture.
const MARKDOWN_IMAGE = /!\[[^\]]*\](?:[ \t]*\([^)\n]*\)?|[ \t]*\[[^\]\n]*\])?/g;
const LINK = /https?:\/\/[^\s'"<>)\]]+/gi;
const IMAGE_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)(?![a-z0-9])/i;

/**
 * The text without markdown images and without links to images, each replaced by
 * {@link IMAGE_LINK_PLACEHOLDER}. Removing one can bring the rest of another together, so it repeats
 * until nothing changes.
 */
export function removeImageLinks(text: string): string {
  let current = text;
  for (let round = 0; round < 5; round += 1) {
    const next = current
      .replace(MARKDOWN_IMAGE, IMAGE_LINK_PLACEHOLDER)
      .replace(LINK, (link) =>
        IMAGE_EXTENSION.test(link) ? IMAGE_LINK_PLACEHOLDER : link,
      );
    if (next === current) return next;
    current = next;
  }
  return current;
}

/**
 * The command a comment asks for, or `null` when the comment is no command: it does not start with
 * one, the word is an unknown one, or `/ask` has no question.
 *
 * Only `/ask` takes text, with markdown images and links to images removed. For the other commands PR-Agent would read text after the command as
 * options (`/review --setting=value`), so it is dropped here and never reaches a job.
 */
export function parseCommentCommand(body: string): ParsedCommentCommand | null {
  const match = COMMAND_PATTERN.exec(body);
  if (match === null) return null;
  const command = (match[1] as string).toLowerCase() as ReviewCommand;
  if (command !== "ask") return { command, args: "" };
  const question = removeImageLinks((match[2] ?? "").trim()).trim();
  if (question === "") return null;
  return { command, args: cutToLength(question) };
}
