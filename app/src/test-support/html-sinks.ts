// SPDX-License-Identifier: Apache-2.0

// The ways a page can turn a string into markup, script or navigation, for the scans that keep text from models.dev out of
// them (#554). Text from the catalog (names, ids, addresses) is untrusted: React escapes what it renders, and none of these
// may appear in the files that render it. The one exception is a link, which `providers-panel.tsx` builds only from an
// address that passed `safeHttpsHref`.

const SINKS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "dangerouslySetInnerHTML", pattern: /\bdangerouslySetInnerHTML\b/ },
  { name: "innerHTML", pattern: /\binnerHTML\b/ },
  { name: "outerHTML", pattern: /\bouterHTML\b/ },
  { name: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/ },
  { name: "document.write", pattern: /\bdocument\s*\.\s*write(ln)?\b/ },
  { name: "srcDoc", pattern: /\bsrcdoc\b/i },
  { name: "eval", pattern: /\beval\s*\(/ },
  { name: "Function constructor", pattern: /\b(new\s+)?Function\s*\(/ },
  { name: "window.open", pattern: /\bwindow\s*\.\s*open\b/ },
  { name: "location", pattern: /\blocation\s*\./ },
];

/** A link: the only file that may build one is the one that checks the address first. */
const ANCHOR = /<a[\s>]/;
const ANCHOR_ALLOWED_IN = "providers-panel.tsx";

/** What in `source` (the text of the file called `file`) could read a string as markup, code or a place to go. */
export function findHtmlSinks(source: string, file: string): string[] {
  const found = SINKS.filter(({ pattern }) => pattern.test(source)).map(
    ({ name }) => `${file}: ${name}`,
  );
  if (ANCHOR.test(source) && file !== ANCHOR_ALLOWED_IN)
    found.push(
      `${file}: anchor (a link is built only in ${ANCHOR_ALLOWED_IN})`,
    );
  return found;
}
