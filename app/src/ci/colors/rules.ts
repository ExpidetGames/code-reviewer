// SPDX-License-Identifier: LicenseRef-Proprietary

// The color guard of the UI redesign (#166): every color of the app lives in exactly one file,
// `app/src/app/theme.css`. This module finds a color literal in the text of a source file, and the
// test beside it scans the real tree. The migration is finished (#185): the legacy `globals.css` and
// its exception are gone, so the guard scans every tracked source file with no exception.
//
// It catches three forms a component could use to write a color on its own:
//   1. a CSS literal — a hex value, an rgb/hsl/oklch function, or one of the CSS color names — as
//      a declaration or a Tailwind arbitrary value;
//   2. a CSS color name as a quoted string value in an inline style (a `color` entry with a quoted
//      value in a JSX `style` object);
//   3. a Tailwind default-palette utility (a background, text or border utility with a palette hue
//      and a shade, or with black/white): colors may only come from this project's tokens.
// A token utility (the same utilities with one of our token names) is not a palette color and
// passes.

/** The one file that may hold color literals. */
export const COLOR_FILE = "app/src/app/theme.css";

export function isColorException(path: string): boolean {
  return path === COLOR_FILE;
}

export type ColorFinding = {
  /** The literal as it appears in the file. */
  literal: string;
  /** The 1-based line of the literal. */
  line: number;
};

// A 3- or 4-digit shorthand is only a color when it carries a letter: a plain number is an issue
// reference in a comment (`// #166`), not a color.
const HEX =
  /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])|#[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]{2,3}(?![0-9a-fA-F])/g;
const FUNCTION = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\s*\(/gi;

// The CSS named colors, matched only where a CSS value would sit: after `:` (a declaration) or `[`
// (a Tailwind arbitrary value) and before a value terminator. A bare word in prose ("white space")
// is not a color.
const NAMED_NAMES = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
];
// Built from parts so this file's own text never looks like a match (`(?:aliceblue` would).
const NAMED_PREFIX = "[:[]\\s*";
const NAMED = new RegExp(
  `${NAMED_PREFIX}(${NAMED_NAMES.join("|")})(?=\\s*(?:[;)\\]!,]|$))`,
  "gim",
);

// A CSS color name as a quoted string value, the form an inline style uses in JSX (a `color`
// entry with a quoted value): the plain NAMED rule only sees an unquoted value.
const COLOR_PROPERTIES =
  "color|background|background-color|backgroundcolor|border-color|bordercolor|outline-color|outlinecolor|fill|stroke|caret-color|caretcolor|accent-color|accentcolor|text-decoration-color|textdecorationcolor|column-rule-color|columnrulecolor|box-shadow|boxshadow|text-shadow|textshadow";
const QUOTED_NAMED = new RegExp(
  `(?:${COLOR_PROPERTIES})\\s*:\\s*["'](${NAMED_NAMES.join("|")})["']`,
  "gi",
);

// Tailwind's built-in palette utilities (a background, text, border, ... utility with a palette
// hue and a shade) are neither a literal nor a function, so the patterns above miss them; a
// component must use a token of this project.
const PALETTE_HUES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PALETTE_UTILITIES =
  "bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent|caret|divide|placeholder";
const TAILWIND_PALETTE = new RegExp(
  `\\b(?:${PALETTE_UTILITIES})-(?:(?:${PALETTE_HUES})-\\d{2,3}|black|white)\\b`,
  "g",
);

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Every color literal in the text, with its line. */
export function findColorLiterals(content: string): ColorFinding[] {
  const findings: ColorFinding[] = [];
  for (const pattern of [
    HEX,
    FUNCTION,
    NAMED,
    QUOTED_NAMED,
    TAILWIND_PALETTE,
  ]) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const literal = (match[1] ?? match[0]).trim();
      findings.push({ literal, line: lineOf(content, match.index) });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** Every color literal of the given files that is not in an exempt file, with the path. */
export function scanColors(
  files: readonly { path: string; content: string }[],
): (ColorFinding & { path: string })[] {
  return files
    .filter((file) => !isColorException(file.path))
    .flatMap((file) =>
      findColorLiterals(file.content).map((finding) => ({
        path: file.path,
        ...finding,
      })),
    );
}
