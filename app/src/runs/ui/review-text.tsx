// SPDX-License-Identifier: LicenseRef-Proprietary

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

const LINE_BREAK = /<br\s*\/?>/gi;
const BLOCK_CLOSE = /<\/(?:p|div|li|tr|h[1-6]|details|table)>/gi;

// The text is from outside and is read on every poll, so every step below walks it once (an `indexOf` that finds nothing is
// remembered): no pattern here can be made to rescan the rest of the text from each of many openers.

/** The text without the HTML comments (`<!-- ... -->`); a comment that never closes stays as text. */
function dropComments(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("<!--", from);
    if (open === -1) break;
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    out += text.slice(from, open);
    from = close + 3;
  }
  return out + text.slice(from);
}

/** Each `<summary ...>words</summary>` as its words on a line of their own, in bold; one that never closes stays as it is. */
function summariesToLines(text: string): string {
  // Only A-Z are lowered, so the positions in `lower` are the positions in `text`.
  const lower = text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  let out = "";
  let from = 0;
  let search = 0;
  for (;;) {
    const open = lower.indexOf("<summary", search);
    if (open === -1) break;
    const tagEnd = text.indexOf(">", open + 8);
    if (tagEnd === -1) break;
    const close = lower.indexOf("</summary>", tagEnd + 1);
    if (close === -1) break;
    out += `${text.slice(from, open)}\n**${text.slice(tagEnd + 1, close).trim()}**\n`;
    from = close + 10;
    search = from;
  }
  return out + text.slice(from);
}

/** The text without its tags (`<b>`, `</p>`, `<a href=...>`); a `<` that opens no tag closed on its own line stays as text. */
function dropTags(text: string): string {
  let out = "";
  let from = 0;
  let search = 0;
  for (;;) {
    const open = text.indexOf("<", search);
    if (open === -1) break;
    const nameAt = text[open + 1] === "/" ? open + 2 : open + 1;
    if (!/[a-zA-Z]/.test(text[nameAt] ?? "")) {
      search = open + 1;
      continue;
    }
    let end = nameAt + 1;
    while (end < text.length && text[end] !== ">" && text[end] !== "\n")
      end += 1;
    if (text[end] === ">") {
      out += text.slice(from, open);
      from = end + 1;
      search = from;
    } else {
      // No `>` before the end of this line: no `<` before `end` can close either, so none is tried again.
      search = end;
    }
  }
  return out + text.slice(from);
}

/** The text without HTML: comments and tags out, summaries and line breaks kept as lines. */
function stripHtml(text: string): string {
  return dropTags(
    summariesToLines(dropComments(text))
      .replace(LINE_BREAK, "\n")
      .replace(BLOCK_CLOSE, "\n"),
  );
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

/** A heading line (`## Words ##`): its level and its words, without the closing hashes. Not a regular expression: a long run of spaces or hashes would make that quadratic. */
function headingOf(line: string): { hashes: number; text: string } | null {
  let hashes = 0;
  while (line[hashes] === "#") hashes += 1;
  if (hashes < 1 || hashes > 6 || !/\s/.test(line[hashes] ?? "")) return null;
  let end = line.length;
  while (end > hashes && line[end - 1] === "#") end -= 1;
  return { hashes, text: line.slice(hashes, end).trim() };
}

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
    const heading = headingOf(line);
    if (heading !== null) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading.hashes <= 2 ? 3 : 4,
        text: heading.text,
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

/** Inline Markdown as elements: code, bold, and a link as its words alone. One walk over each line (see `stripHtml`). */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const plain = (words: string) => {
    if (words !== "") parts.push(<span key={parts.length}>{words}</span>);
  };
  text.split("\n").forEach((line, lineIndex) => {
    if (lineIndex > 0) plain("\n");
    let from = 0;
    let at = 0;
    // A closer that is missing from here on is missing for every later opener too.
    let noBacktick = false;
    let noBracket = false;
    let noParen = false;
    while (at < line.length) {
      const char = line[at];
      if (char === "`" && !noBacktick) {
        const close = line.indexOf("`", at + 1);
        if (close === -1) noBacktick = true;
        else if (close > at + 1) {
          plain(line.slice(from, at));
          parts.push(
            <code key={parts.length} className="font-mono text-[0.9em]">
              {line.slice(at + 1, close)}
            </code>,
          );
          from = at = close + 1;
          continue;
        }
      } else if (char === "*" && line[at + 1] === "*") {
        const star = line.indexOf("*", at + 2);
        if (star > at + 2 && line[star + 1] === "*") {
          plain(line.slice(from, at));
          parts.push(
            <strong key={parts.length}>{line.slice(at + 2, star)}</strong>,
          );
          from = at = star + 2;
          continue;
        }
      } else if (char === "[" && !noBracket && !noParen) {
        const bracket = line.indexOf("]", at + 1);
        if (bracket === -1) noBracket = true;
        else if (line[bracket + 1] !== "(") {
          // No `[` before this `]` can be a link either.
          at = bracket;
          continue;
        } else {
          const paren = line.indexOf(")", bracket + 2);
          if (paren === -1) noParen = true;
          else {
            plain(line.slice(from, at));
            parts.push(
              <span key={parts.length}>{line.slice(at + 1, bracket)}</span>,
            );
            from = at = paren + 1;
            continue;
          }
        }
      }
      at += 1;
    }
    plain(line.slice(from));
  });
  return parts;
}

// The same review text is shown again on every poll: the last few readings are kept by their text.
const READINGS = new Map<string, Block[]>();
const READINGS_KEPT = 8;

export function readReviewText(text: string): Block[] {
  const known = READINGS.get(text);
  if (known !== undefined) return known;
  const blocks = parseReviewText(text);
  if (READINGS.size >= READINGS_KEPT)
    READINGS.delete(READINGS.keys().next().value as string);
  READINGS.set(text, blocks);
  return blocks;
}

export function ReviewText({ text }: { text: string }) {
  const blocks = readReviewText(text);
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
