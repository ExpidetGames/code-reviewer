// SPDX-License-Identifier: Apache-2.0

// The text of a posted review (a comment written in Markdown with a little HTML), shown readably and safely. It is text from
// outside: nothing of it becomes markup. It is cut into blocks (headings, lists, quotes, code, paragraphs) and every block is
// built from React elements, so a tag, a script or a link in it is only ever text. HTML comments (the hidden markers of the
// review) and tags are dropped, a link shows its words and not its address, and a table is read row by row. No state, so a
// server component can use it.
import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SUMMARY = /<summary[^>]*>([\s\S]*?)<\/summary>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;
const BLOCK_CLOSE = /<\/(?:p|div|li|tr|h[1-6]|details|table)>/gi;
const TAG = /<\/?[a-zA-Z][^>\n]*>/g;

/** The text without HTML: comments and tags out, summaries and line breaks kept as lines. */
function stripHtml(text: string): string {
  return text
    .replace(HTML_COMMENT, "")
    .replace(SUMMARY, (_all, inner: string) => `\n**${inner.trim()}**\n`)
    .replace(LINE_BREAK, "\n")
    .replace(BLOCK_CLOSE, "\n")
    .replace(TAG, "");
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

/** A table row as one line: its cells side by side. */
function rowText(line: string): string {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "")
    .join(" · ");
}

export function parseReviewText(source: string): Block[] {
  const lines = stripHtml(source.replace(/\r\n?/g, "\n")).split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length <= 2 ? 3 : 4,
        text: heading[2] ?? "",
      });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (TABLE_SEPARATOR.test(line)) continue;
    if (TABLE_ROW.test(line)) {
      flush();
      const text = rowText(line);
      if (text !== "") blocks.push({ kind: "paragraph", text });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flush();
      const last = blocks.at(-1);
      if (last?.kind === "quote") last.text += ` ${quote[1] ?? ""}`;
      else blocks.push({ kind: "quote", text: quote[1] ?? "" });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    const item = bullet ?? numbered;
    if (item !== null) {
      flush();
      const ordered = numbered !== null;
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered)
        last.items.push(item[1] ?? "");
      else blocks.push({ kind: "list", ordered, items: [item[1] ?? ""] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]*\]\([^)\n]*\))/g;

/** Inline Markdown as elements: code, bold, and a link as its words alone. */
function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={index} className="font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]\n]*)\]\([^)\n]*\)$/.exec(part);
    if (link !== null) return <span key={index}>{link[1]}</span>;
    return <span key={index}>{part}</span>;
  });
}

export function ReviewText({ text }: { text: string }) {
  const blocks = parseReviewText(text);
  return (
    <div
      data-slot="review-text"
      className="flex max-w-none flex-col gap-3 text-sm leading-6 break-words"
    >
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return block.level === 3 ? (
              <h3 key={index} className="text-base font-semibold">
                {inline(block.text)}
              </h3>
            ) : (
              <h4 key={index} className="text-sm font-semibold">
                {inline(block.text)}
              </h4>
            );
          case "paragraph":
            return <p key={index}>{inline(block.text)}</p>;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag
                key={index}
                className={`flex flex-col gap-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote
                key={index}
                className="border-l-2 border-border pl-3 text-muted-foreground"
              >
                {inline(block.text)}
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={index}
                tabIndex={0}
                className="max-h-80 overflow-auto rounded-xl bg-raised p-3 font-mono text-xs leading-4 whitespace-pre-wrap"
              >
                {block.text}
              </pre>
            );
          case "rule":
            return <hr key={index} className="border-border" />;
        }
      })}
    </div>
  );
}
