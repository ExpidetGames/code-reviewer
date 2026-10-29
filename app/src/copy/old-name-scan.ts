// SPDX-License-Identifier: LicenseRef-Proprietary

// The scan for the old product name "Code Reviewer" in the text a source file can show or send (#635):
// string literals, template literal parts and JSX text. Comments and identifiers are not text a customer
// sees, so they are not scanned. Pure: the caller reads the files.
import ts from "typescript";

/** A text in a source file that still says the old name. */
export type OldNameFinding = { path: string; line: number; text: string };

/** A text that keeps the old name on purpose, with the reason. */
export type OldNameException = { path: string; text: string; reason: string };

const OLD_NAME = /code\s+reviewer/i;

/** Every string literal, template literal part and JSX text of the file that says the old name. */
export function findOldName(path: string, content: string): OldNameFinding[] {
  return findText(path, content, OLD_NAME);
}

/** Every string literal, template literal part and JSX text of the file that matches the pattern (comments and identifiers do not count). */
export function findText(
  path: string,
  content: string,
  pattern: RegExp,
): OldNameFinding[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const found: OldNameFinding[] = [];
  const visit = (node: ts.Node) => {
    const text = textOf(node);
    if (text !== null && pattern.test(text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push({ path, line: line + 1, text: text.trim() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The findings that no exception covers. */
export function withoutExceptions(
  findings: readonly OldNameFinding[],
  exceptions: readonly OldNameException[],
): OldNameFinding[] {
  return findings.filter(
    (finding) =>
      !exceptions.some(
        (exception) =>
          exception.path === finding.path && exception.text === finding.text,
      ),
  );
}

function textOf(node: ts.Node): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  )
    return node.text;
  return null;
}
