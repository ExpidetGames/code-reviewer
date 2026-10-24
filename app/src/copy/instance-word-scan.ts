// SPDX-License-Identifier: LicenseRef-Proprietary

// The scan for the word "instance" in the text a source file can show or send (#675): string literals, template
// literal parts and JSX text. Nothing the customer or the admin reads says "instance"; where the managed key or the
// billing is meant it says "billed via code-review.com". Comments, identifiers, module paths and the technical tokens
// that contain the word (the table `instance_settings`, the route `/instance-portal`, the key `billing-top-up:instance`) are not text a person reads, so
// they are not findings. Pure: the caller reads the files.
import ts from "typescript";

/** A text in a source file that says "instance". */
export type InstanceWordFinding = { path: string; line: number; text: string };

/** A text that keeps the word on purpose (a log line, a command line of the operator), with the reason. */
export type InstanceWordException = {
  path: string;
  text: string;
  reason: string;
};

const WORD = /\binstances?\b/i;

/** A token with a joiner in it (`instance_settings`, `/instance-portal/x`, `is_instance_admin`): an identifier, not prose. */
const TECHNICAL_TOKEN = /[\w./@:[\]-]*[_/@:[\]-][\w./@:[\]-]*/g;

/**
 * Whether the text says the word in prose, after the technical tokens are taken out. The bare lowercase word alone is a
 * code value (the `"instance"` scope of a rate limit); a label that says it starts with a capital.
 */
export function saysInstance(text: string): boolean {
  if (/^instances?$/.test(text)) return false;
  return WORD.test(text.replace(TECHNICAL_TOKEN, " "));
}

/** Every string literal, template literal part and JSX text of the file that says the word. */
export function findInstanceWord(
  path: string,
  content: string,
): InstanceWordFinding[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const found: InstanceWordFinding[] = [];
  const visit = (node: ts.Node) => {
    const text = textOf(node);
    if (text !== null && !isModulePath(node) && saysInstance(text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push({
        path,
        line: line + 1,
        text: text.replace(/\s+/g, " ").trim(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The findings that no exception covers. */
export function withoutInstanceExceptions(
  findings: readonly InstanceWordFinding[],
  exceptions: readonly InstanceWordException[],
): InstanceWordFinding[] {
  return findings.filter(
    (finding) =>
      !exceptions.some(
        (exception) =>
          exception.path === finding.path &&
          finding.text.includes(exception.text),
      ),
  );
}

function isModulePath(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
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
