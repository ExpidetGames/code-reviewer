// SPDX-License-Identifier: Apache-2.0

// Reading `app/src/app/theme.css` for the tests: the declaration blocks of the light, system-dark
// and explicit-dark states, resolution of `var()` references, and the WCAG contrast ratio. Kept
// pure and separate from the test so both the token check and the contrast check use one parser.

export type Tokens = Record<string, string>;

/** The `--name: value;` declarations between the braces of `selector { ... }`. */
export function declarationBlock(css: string, selector: string): Tokens {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < css.length; end += 1) {
    if (css[end] === "{") depth += 1;
    if (css[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = css.slice(open + 1, end);
  const tokens: Tokens = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    if (match[1] && match[2]) tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

/** Follows `var(--x)` references until a literal value; throws on an unknown or circular token. */
export function resolveToken(tokens: Tokens, name: string): string {
  let value = tokens[name];
  if (value === undefined) throw new Error(`unknown token ${name}`);
  const seen = new Set<string>();
  for (;;) {
    const reference = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim());
    if (!reference) return value;
    if (seen.has(reference[1]!)) throw new Error(`circular token ${name}`);
    seen.add(reference[1]!);
    const next = tokens[reference[1]!];
    if (next === undefined) throw new Error(`unresolved token ${name}`);
    value = next;
  }
}

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`not a six digit hex color: ${hex}`);
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** WCAG 2.1 relative luminance of an `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2.1 contrast ratio between two `#rrggbb` colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}
