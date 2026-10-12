// SPDX-License-Identifier: Apache-2.0

// The color guard of the UI redesign (#166): every color of the app lives in exactly one file,
// `app/src/app/theme.css`. This module finds a color literal in the text of a source file, and the
// test beside it scans the real tree. `app/src/app/globals.css` is the one documented exception
// during the incremental migration; the cleanup issue (#185) removes it together with the file.

/** The one file that may hold color literals. */
export const COLOR_FILE = "app/src/app/theme.css";

/** The documented exception of the migration: the legacy stylesheet. */
export const COLOR_FILE_EXCEPTION = "app/src/app/globals.css";

export const COLOR_EXCEPTION_PATHS = [
  COLOR_FILE,
  COLOR_FILE_EXCEPTION,
] as const;

export function isColorException(path: string): boolean {
  return (COLOR_EXCEPTION_PATHS as readonly string[]).includes(path);
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

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Every color literal in the text, with its line. */
export function findColorLiterals(content: string): ColorFinding[] {
  const findings: ColorFinding[] = [];
  for (const pattern of [HEX, FUNCTION, NAMED]) {
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
