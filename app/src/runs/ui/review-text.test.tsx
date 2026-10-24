// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// #657-T04: the text of a posted review is shown readably (headings, lists, code, quotes) and safely: it is text from outside,
// so no tag, script, link or hidden marker of it becomes markup or shows.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewText, readReviewText, ReviewText } from "./review-text.tsx";

afterEach(cleanup);

describe("the text of a posted review", () => {
  it("reads headings, lists, quotes and code as such", () => {
    const { container } = render(
      <ReviewText
        text={[
          "## PR Reviewer Guide",
          "",
          "#### P1 - Missing check",
          "",
          "A `null` value is **not** handled.",
          "",
          "- first finding",
          "- second finding",
          "",
          "1. step one",
          "2. step two",
          "",
          "> a quoted line",
          "",
          "```ts",
          "const a = 1;",
          "```",
        ].join("\n")}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "PR Reviewer Guide", level: 3 }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "P1 - Missing check", level: 4 }),
    ).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toBe("null");
    expect(container.querySelector("strong")?.textContent).toBe("not");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      ["first finding", "second finding", "step one", "step two"],
    );
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelector("blockquote")?.textContent).toBe(
      "a quoted line",
    );
    expect(container.querySelector("pre")?.textContent).toBe("const a = 1;");
  });

  it("drops the hidden markers and the tags of the HTML in a review, keeping the words", () => {
    const { container } = render(
      <ReviewText
        text={
          "<!-- pr-agent:review:full -->\n<details><summary>Evidence</summary>\nThe call is made here.\n</details>\n<table><tr><td>Effort</td><td>3/5</td></tr></table>"
        }
      />,
    );

    expect(container.textContent).not.toContain("pr-agent");
    expect(container.textContent).not.toContain("<");
    expect(container.textContent).toContain("Evidence");
    expect(container.textContent).toContain("The call is made here.");
    expect(container.textContent).toContain("Effort");
    expect(container.textContent).toContain("3/5");
  });

  it("never turns text from outside into markup: no script, no image, no link", () => {
    const { container } = render(
      <ReviewText
        text={
          "Click [here](https://evil.example/x) <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[javascript](javascript:alert(1))"
        }
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("here");
    expect(container.textContent).not.toContain("evil.example");
  });

  it("reads a Markdown table row by row", () => {
    const { container } = render(
      <ReviewText
        text={"| File | Issue |\n|---|---|\n| a.ts | Missing check |"}
      />,
    );

    expect(container.textContent).toContain("File · Issue");
    expect(container.textContent).toContain("a.ts · Missing check");
    expect(container.textContent).not.toContain("---");
  });
  // A review comes from outside and is read on every poll: hostile text must not cost seconds of CPU. Before the linear scan
  // 65,536 characters of "<a<a<a" took ~1.9 s, of "<!--" ~1.6 s and of "<summary " ~0.5 s.
  describe.each([
    ["open tags that never close", "<a".repeat(32768)],
    ["comment openers that never close", "<!--".repeat(16384)],
    ["summary openers that never close", "<summary ".repeat(7282)],
    ["summary openers with no end tag", "<summary >".repeat(6554)],
    ["links that never close", "[a](".repeat(16384)],
    ["brackets that never close", "[".repeat(65536)],
    ["stars", "*".repeat(65536)],
    ["a heading with a long run of hashes", `# x${"#".repeat(65530)}y`],
    ["backticks that never close", "`".repeat(65536)],
    ["a heading with a long run of spaces", `# x${" ".repeat(65530)}y`],
  ])("with %s", (_name, text) => {
    it("is read in linear time", () => {
      const started = performance.now();
      render(<ReviewText text={text.slice(0, 65536)} />);
      expect(performance.now() - started).toBeLessThan(200);
    });
  });

  it("reads the same text once and hands the same blocks to every later render", () => {
    const text = "## Same\n\n- one\n- two";
    const first = readReviewText(text);
    expect(readReviewText(text)).toBe(first);
    expect(readReviewText(`${text}\n\nmore`)).not.toBe(first);
  });

  it("reads a heading without its closing hashes and only up to six opening ones", () => {
    expect(
      parseReviewText("## Title ##\n####### seven\n#nospace\n### a # b ###"),
    ).toEqual([
      { kind: "heading", level: 3, text: "Title" },
      { kind: "paragraph", text: "####### seven #nospace" },
      { kind: "heading", level: 4, text: "a # b" },
    ]);
  });

  it("keeps the words of unterminated markup and strips the terminated one", () => {
    const blocks = parseReviewText(
      "a <!-- gone --> b <!-- open\n<summary>Title</summary> c <b>bold</b> <i",
    );
    expect(blocks).toEqual([
      { kind: "paragraph", text: "a  b <!-- open" },
      { kind: "paragraph", text: "**Title** c bold <i" },
    ]);
  });
});
