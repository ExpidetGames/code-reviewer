// SPDX-License-Identifier: Apache-2.0

// Pins down how a comment is read as a command: only a comment that starts with one of the four
// commands counts, only /ask carries text, and that text is cut to a fixed length.
import { describe, expect, it } from "vitest";
import askQuestionImages from "../../../fakes/fixtures/ask-question-images.json" with { type: "json" };
import {
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTION_RAW_MAX_CHARS,
  ASK_QUESTION_TRUNCATION_NOTE,
  IMAGE_LINK_PLACEHOLDER,
  parseCommentCommand,
  removeImageLinks,
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

  it("cuts by UTF-16 length and never inside a surrogate pair, so the job always fits the runner's limit", () => {
    const emoji = "\u{1F600}";
    const result = parseCommentCommand(
      `/ask ${emoji.repeat(ASK_QUESTION_MAX_CHARS)}`,
    );

    const cut = result?.args.split("\n\n")[0] ?? "";
    expect(cut.length).toBeLessThanOrEqual(ASK_QUESTION_MAX_CHARS);
    expect(cut.length % 2).toBe(0);
    expect(cut).toBe(emoji.repeat(ASK_QUESTION_MAX_CHARS / 2));
    // The claim refuses a question of more than 4000 UTF-16 units.
    expect(result?.args.length).toBeLessThanOrEqual(4000);
    expect(result?.args).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("keeps a lone high surrogate at the cut out of the question", () => {
    const text = `${"a".repeat(ASK_QUESTION_MAX_CHARS - 1)}\u{1F600}more`;

    const cut = (parseCommentCommand(`/ask ${text}`)?.args ?? "").split(
      "\n\n",
    )[0];

    expect(cut).toBe("a".repeat(ASK_QUESTION_MAX_CHARS - 1));
  });
});

describe("removing image links from a question", () => {
  // PR-Agent downloads the first image of an /ask question from the runner, so a user could make the
  // runner request an address of their choice. The links never reach a job.
  it("uses the placeholder the runner uses", () => {
    expect(askQuestionImages.placeholder).toBe(IMAGE_LINK_PLACEHOLDER);
  });

  it.each(askQuestionImages.cases)("$name", ({ input, expected }) => {
    expect(removeImageLinks(input)).toBe(expected);
  });

  it("is applied to the question of /ask before it becomes the job's arguments", () => {
    expect(
      parseCommentCommand("/ask what is ![image](https://evil.test/a.png) ?"),
    ).toEqual({ command: "ask", args: "what is [image link removed] ?" });
  });

  it("leaves a question that is only an image without a question", () => {
    expect(parseCommentCommand("/ask https://evil.test/a.png")).toEqual({
      command: "ask",
      args: "[image link removed]",
    });
  });

  it("leaves nothing that PR-Agent would fetch, whatever the question holds", () => {
    const nasty = [
      "!!![image](https://a.test/x.png)",
      "!https://a.test/x.png",
      "ht![x](y)tps://a.test/x.png",
      "https://a.test/x.pn![x](y)g",
      "![![image](a)](https://a.test/x.png)",
    ];
    for (const input of nasty) {
      const cleaned = removeImageLinks(input);
      expect(cleaned, input).not.toContain("![image]");
      expect(cleaned, input).not.toMatch(
        /https?:\/\/\S*\.(png|jpe?g|gif|webp)/i,
      );
    }
  });
});

// The parser runs on every comment of every commenter, before anything is known about them, so no
// text may make it slow. GitHub allows 65 536 characters in a comment.
describe("reading hostile comments", () => {
  const BIG = 64_000;
  const shapes: [string, string][] = [
    ["unclosed markdown images", "![".repeat(BIG / 2)],
    ["closed empty markdown images", "![]".repeat(BIG / 3)],
    ["short markdown images", "![a]".repeat(BIG / 4)],
    ["images with open parentheses", "![a](".repeat(BIG / 5)],
    ["one very long alt text", `![${"a".repeat(BIG)}`],
    ["one very long link target", `![a](${"a".repeat(BIG)}`],
    ["an image followed by many spaces", `![a]${" ".repeat(BIG)}x`],
    ["many brackets", "[".repeat(BIG)],
    ["many closing brackets", "]".repeat(BIG)],
    ["many exclamation marks", "!".repeat(BIG)],
    ["many parentheses", "(".repeat(BIG)],
    ["many schemes", "http://".repeat(BIG / 7)],
    ["many secure schemes", "https://".repeat(BIG / 8)],
    ["one very long link", `https://x.test/${"a".repeat(BIG)}`],
    ["many extensions in one link", `https://x.test/${".png".repeat(BIG / 4)}`],
    ["many dots in one link", `https://x.test/${".".repeat(BIG)}`],
    ["many links", "https://x.test/a.png ".repeat(BIG / 21)],
    ["many line breaks", "\n".repeat(BIG)],
    ["many mixed white space", " \t\n".repeat(BIG / 3)],
  ];

  // CR-32-T04
  it.each(shapes)("reads %s quickly", (_name, text) => {
    for (const body of [`/ask ${text}`, text, `${text}\n/ask x`]) {
      const start = performance.now();
      parseCommentCommand(body);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(500);
    }
  });

  // The patterns are bounded on their own, not only because the question is cut before them.
  it.each(shapes)("removes image links from %s quickly", (_name, text) => {
    const start = performance.now();
    removeImageLinks(text);

    expect(performance.now() - start).toBeLessThan(500);
  });

  it("reads white space before a command quickly", () => {
    const start = performance.now();
    parseCommentCommand(`${" ".repeat(BIG)}/ask what?`);
    parseCommentCommand(`${" ".repeat(BIG)}no command`);

    expect(performance.now() - start).toBeLessThan(500);
  });

  it("looks at no more than the raw maximum of a question, and says it was cut", () => {
    const result = parseCommentCommand(
      `/ask ${"q".repeat(ASK_QUESTION_RAW_MAX_CHARS * 3)}`,
    );

    expect(result?.args).toBe(
      `${"q".repeat(ASK_QUESTION_MAX_CHARS)}\n\n${ASK_QUESTION_TRUNCATION_NOTE}`,
    );
  });

  it("says a question was cut also when its first part shrinks below the maximum once links are removed", () => {
    const links = "![image](https://x.test/a.png) ".repeat(
      ASK_QUESTION_RAW_MAX_CHARS,
    );

    const result = parseCommentCommand(`/ask ${links}`);

    expect(result?.args).toContain(ASK_QUESTION_TRUNCATION_NOTE);
    expect(result?.args).not.toContain("https://");
  });

  it("removes an image that begins inside the raw maximum and ends outside it", () => {
    const text = `${"a".repeat(ASK_QUESTION_RAW_MAX_CHARS - 12)} ![image](https://evil.test/a.png) tail`;

    const args = parseCommentCommand(`/ask ${text}`)?.args ?? "";

    expect(args).not.toContain("evil.test");
    expect(args).not.toContain("![image]");
  });
});
