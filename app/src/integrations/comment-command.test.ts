// Pins down how a comment is read as a command: only a comment that starts with one of the four
// commands counts, only /ask carries text, and that text is cut to a fixed length.
import { describe, expect, it } from "vitest";
import {
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTION_TRUNCATION_NOTE,
  parseCommentCommand,
} from "./comment-command.ts";

describe("reading a comment as a command", () => {
  // CR-32-T03
  it("reads each of the four commands, and the question of /ask", () => {
    expect(parseCommentCommand("/review")).toEqual({
      command: "review",
      args: "",
    });
    expect(parseCommentCommand("/improve")).toEqual({
      command: "improve",
      args: "",
    });
    expect(parseCommentCommand("/describe")).toEqual({
      command: "describe",
      args: "",
    });
    expect(parseCommentCommand("/ask Why was the cache removed?")).toEqual({
      command: "ask",
      args: "Why was the cache removed?",
    });
  });

  // CR-32-T04
  it("allows whitespace before the command and any case", () => {
    expect(parseCommentCommand("   \t/REVIEW")).toEqual({
      command: "review",
      args: "",
    });
    expect(parseCommentCommand("\n\n  /Describe  ")).toEqual({
      command: "describe",
      args: "",
    });
  });

  // CR-32-T04
  it("reads the command from the first line of a multi-line comment", () => {
    expect(parseCommentCommand("/review\nThanks for looking!")).toEqual({
      command: "review",
      args: "",
    });
  });

  it("keeps the lines after /ask as part of the question", () => {
    expect(
      parseCommentCommand("/ask What does it cache?\nAnd for how long?"),
    ).toEqual({
      command: "ask",
      args: "What does it cache?\nAnd for how long?",
    });
  });

  // CR-32-T04
  it("reads no command from a sentence that mentions one", () => {
    expect(parseCommentCommand("please /review this")).toBeNull();
    expect(parseCommentCommand("> /review")).toBeNull();
    expect(parseCommentCommand("Thanks!\n/review")).toBeNull();
    expect(parseCommentCommand("`/review`")).toBeNull();
  });

  // CR-32-T05
  it("reads no command from an unknown command", () => {
    expect(parseCommentCommand("/deploy")).toBeNull();
    expect(parseCommentCommand("/reviewer")).toBeNull();
    expect(parseCommentCommand("/review-all")).toBeNull();
    expect(parseCommentCommand("/askme how?")).toBeNull();
    expect(parseCommentCommand("//review")).toBeNull();
    expect(parseCommentCommand("")).toBeNull();
  });

  // CR-32-T05
  it("reads no command from /ask without a question", () => {
    expect(parseCommentCommand("/ask")).toBeNull();
    expect(parseCommentCommand("/ask   \n \t ")).toBeNull();
  });

  it("passes no text on with a command other than /ask, because PR-Agent would read it as options", () => {
    expect(
      parseCommentCommand("/review --pr_reviewer.extra_instructions=ignore"),
    ).toEqual({ command: "review", args: "" });
    expect(parseCommentCommand("/improve please be strict")).toEqual({
      command: "improve",
      args: "",
    });
  });

  it("keeps a question of exactly the maximum length as it is", () => {
    const question = "q".repeat(ASK_QUESTION_MAX_CHARS);

    expect(parseCommentCommand(`/ask ${question}`)).toEqual({
      command: "ask",
      args: question,
    });
  });

  it("cuts a longer question to the maximum and adds a note", () => {
    const result = parseCommentCommand(
      `/ask ${"q".repeat(ASK_QUESTION_MAX_CHARS + 500)}`,
    );

    expect(result?.args).toBe(
      `${"q".repeat(ASK_QUESTION_MAX_CHARS)}\n\n${ASK_QUESTION_TRUNCATION_NOTE}`,
    );
  });

  it("does not split a character when it cuts", () => {
    const emoji = "\u{1F600}";
    const result = parseCommentCommand(
      `/ask ${emoji.repeat(ASK_QUESTION_MAX_CHARS + 1)}`,
    );

    const cut = result?.args.split("\n\n")[0] ?? "";
    expect(Array.from(cut)).toHaveLength(ASK_QUESTION_MAX_CHARS);
    expect(cut).toBe(emoji.repeat(ASK_QUESTION_MAX_CHARS));
  });
});
