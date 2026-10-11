// SPDX-License-Identifier: Apache-2.0

// The import rule behind the integration boundary: platform specific code (a provider
// implementation under src/integrations/providers/) is imported by the registry and by the provider's
// own folder only. Everything else, jobs, the runner API, the UI, depends on the normalized types,
// the IntegrationProvider interface and the registry. Pure function, no file system access, so it can
// be run by a test today and by a structure check (`verify:structure`) later.
//
// The files are parsed with the TypeScript compiler, so comments and strings never count, and these
// forms do: `import`/`export ... from`, `import x = require()`, `import()` (also as a type),
// `require()`, and `vi.mock`/`vi.doMock`/`vi.importActual`-style calls (`jest.*` too). A template
// literal with substitutions counts when its fixed start already points into a provider folder.
// A specifier that is built entirely at run time cannot be seen.
import { posix } from "node:path";
import ts from "typescript";

export type SourceFile = {
  /** Path relative to the app folder, for example "src/jobs/enqueue.ts". */
  path: string;
  content: string;
};

export type ProviderImportViolation = {
  file: string;
  /** The import specifier exactly as written (for a template literal: its fixed start). */
  specifier: string;
};

const PROVIDERS_DIRECTORY = "src/integrations/providers";
const REGISTRY_FILE = "src/integrations/registry.ts";
const MODULE_FUNCTIONS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
]);

function resolveSpecifier(file: string, specifier: string): string | null {
  const resolved = specifier.startsWith("@/")
    ? posix.join("src", specifier.slice(2))
    : specifier.startsWith(".")
      ? posix.join(posix.dirname(file), specifier)
      : null;
  return resolved === null ? null : resolved.replace(/\/+$/, "");
}

function isInsideProviders(path: string): boolean {
  return (
    path === PROVIDERS_DIRECTORY || path.startsWith(`${PROVIDERS_DIRECTORY}/`)
  );
}

/** The fixed text of a module specifier expression, or undefined if it has none. */
function specifierText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return undefined;
}

function specifiersOf(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const add = (node: ts.Node | undefined) => {
    const text = specifierText(node);
    if (text !== undefined) found.push(text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isModuleCall =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          (callee.expression.text === "vi" ||
            callee.expression.text === "jest") &&
          MODULE_FUNCTIONS.has(callee.name.text));
      if (isModuleCall) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function findProviderImportViolations(
  files: SourceFile[],
): ProviderImportViolation[] {
  const violations: ProviderImportViolation[] = [];

  for (const { path, content } of files) {
    const file = path.split("\\").join("/");
    if (file === REGISTRY_FILE || isInsideProviders(file)) continue;

    const source = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const specifier of specifiersOf(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved !== null && isInsideProviders(resolved))
        violations.push({ file, specifier });
    }
  }
  return violations;
}
