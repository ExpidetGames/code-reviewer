// SPDX-License-Identifier: LicenseRef-Proprietary

// The scan that keeps text from models.dev out of every place a browser would read it as markup or code (#554): the sinks
// it knows, and the one place a link is allowed.
import { describe, expect, it } from "vitest";
import { findHtmlSinks } from "./html-sinks.ts";

describe("the scan for ways to turn text into markup or code", () => {
  // #554-T07
  it.each([
    [
      "dangerouslySetInnerHTML",
      "<div dangerouslySetInnerHTML={{ __html: x }} />",
    ],
    ["innerHTML", "node.innerHTML = x;"],
    ["outerHTML", "node.outerHTML = x;"],
    ["insertAdjacentHTML", 'node.insertAdjacentHTML("beforeend", x);'],
    ["document.write", "document.write(x);"],
    ["document.writeln", "document.writeln(x);"],
    ["srcDoc", "<iframe srcDoc={x} />"],
    ["eval", "eval(x);"],
    ["new Function", 'const run = new Function("return " + x);'],
    ["Function(", 'Function("return " + x)();'],
    ["window.open", "window.open(x);"],
    ["location.", "location.href = x;"],
    ["window.location", "window.location.assign(x);"],
  ])("finds %s", (name, source) => {
    expect(findHtmlSinks(source, "somewhere.tsx").length).toBeGreaterThan(0);
  });

  // #554-T07
  it("finds a link in any file but the one that checks its address", () => {
    const link = '<a\n  href={href}\n  rel="noopener noreferrer"\n>x</a>';

    expect(findHtmlSinks(link, "models-table.tsx")).toEqual([
      expect.stringContaining("anchor"),
    ]);
    expect(findHtmlSinks(link, "providers-panel.tsx")).toEqual([]);
    expect(findHtmlSinks("<a href={x}>y</a>", "fetch-panel.tsx")).toHaveLength(
      1,
    );
  });

  // #554-T07
  it("does not flag words that only contain a sink's name", () => {
    const source = [
      "const allocation = 1;",
      "const medieval = 2;",
      "const relocation = { href: x };",
      "<Link href={href}>x</Link>",
      "<abbr title={x}>x</abbr>",
    ].join("\n");

    expect(findHtmlSinks(source, "somewhere.tsx")).toEqual([]);
  });
});
