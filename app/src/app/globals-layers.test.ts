// SPDX-License-Identifier: Apache-2.0

// The cascade-layer guard for the legacy stylesheet (epic #165, review of #167). Tailwind's
// utilities live in `@layer utilities`; an unlayered element rule (`a { color }`, `button { font }`)
// beats them, which made a kit button render with the link color and the wrong font. Element-level
// base rules must therefore live in `@layer base`; the legacy class rules (`.btn`, `.card`, ...) stay
// unlayered on purpose (they must keep winning until their screens move to the kit).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./globals.css", import.meta.url)),
  "utf8",
);

type Rule = {
  selector: string;
  /** The rule sits inside an `@layer { ... }` block. */
  inLayer: boolean;
  /** The rule sits inside `@keyframes` (its "selector" is `from`/`to`/a percentage). */
  inKeyframes: boolean;
  line: number;
};

// A small walker over the stylesheet: it returns every declaration rule with its selector and
// whether an enclosing `@layer` holds it.
function rules(source: string): Rule[] {
  // Keep the newlines so the reported line numbers stay right.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const found: Rule[] = [];
  const stack: { layer: boolean; keyframes: boolean }[] = [];
  let buffer = "";
  let bufferLine = 1;
  let line = 1;

  for (const char of text) {
    if (char === "\n") line += 1;
    if (char === "{") {
      const prelude = buffer.trim();
      buffer = "";
      const atRule = /^@([a-z-]+)/i.exec(prelude);
      if (atRule) {
        stack.push({
          layer: atRule[1] === "layer" || (stack.at(-1)?.layer ?? false),
          keyframes:
            atRule[1] === "keyframes" || (stack.at(-1)?.keyframes ?? false),
        });
      } else {
        found.push({
          selector: prelude,
          inLayer: stack.some((entry) => entry.layer),
          inKeyframes: stack.some((entry) => entry.keyframes),
          line: bufferLine,
        });
        stack.push({ layer: false, keyframes: false });
      }
      bufferLine = line;
    } else if (char === "}") {
      stack.pop();
      buffer = "";
      bufferLine = line;
    } else if (char === ";") {
      // A statement (`@layer …;`, `@import …;`) or a declaration separator inside a rule; it never
      // opens a block, so it never pushes or pops the stack.
      buffer = "";
      bufferLine = line;
    } else {
      if (buffer.trim() === "") bufferLine = line;
      buffer += char;
    }
  }
  return found;
}

/** A selector with no class (`.`) and no id (`#`): it styles elements, not a class of them. */
function isElementSelector(selector: string): boolean {
  return !selector.includes(".") && !selector.includes("#");
}

describe("globals.css cascade layers", () => {
  it("declares the layer order before it uses a layer", () => {
    const order = css.indexOf("@layer theme, base, components, utilities;");
    const firstBaseBlock = css.indexOf("@layer base {");
    expect(order).toBeGreaterThanOrEqual(0);
    expect(firstBaseBlock).toBeGreaterThan(order);
  });

  it("keeps every element-level rule in @layer base", () => {
    const offenders = rules(css)
      .filter((rule) => !rule.inLayer && !rule.inKeyframes)
      .filter((rule) => rule.selector.split(",").some(isElementSelector))
      .map((rule) => `${rule.line}: ${rule.selector}`);

    expect(offenders).toEqual([]);
  });

  it("leaves the legacy class rules unlayered so they keep their look", () => {
    const layered = rules(css)
      .filter((rule) => rule.inLayer)
      .map((rule) => rule.selector);

    expect(layered.some((selector) => selector.includes(".btn"))).toBe(false);
    expect(layered.some((selector) => selector.includes(".card"))).toBe(false);
  });
});
