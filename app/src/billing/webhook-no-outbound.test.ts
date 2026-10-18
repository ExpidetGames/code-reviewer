// SPDX-License-Identifier: Apache-2.0

// #441-T15: the webhook handler makes no outbound call. Paddle wants its answer within five seconds and a cold start counts, so
// nothing on the path of a delivery may wait for another server. Read from the source, as a structure test: the modules the
// handler is made of (and everything they import at run time, inside the app) must not import the Paddle client, the HTTP client
// or any module that calls out, and must not call `fetch`. The runtime counterpart (a spy on `fetch` through whole deliveries) is in
// webhook-handler.integration.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const ENTRY = join(import.meta.dirname, "webhook-handler.ts");

/** Modules that reach another server. Nothing the handler imports may be one of them, or import one. */
const OUTBOUND = [
  "billing/paddle-client.ts",
  "billing/prices-service.ts",
  "billing/settings-service.ts",
  "billing/shared.ts",
  "integrations/",
  "notifications/",
  "mail/",
];

type Reading = { runtimeImports: string[]; usesNetwork: boolean };

function read(file: string): Reading {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const runtimeImports: string[] = [];
  let usesNetwork = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly &&
      // `import { type X }` only: nothing is loaded.
      !(
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.name === undefined &&
        node.importClause.namedBindings.elements.every(
          (element) => element.isTypeOnly,
        )
      )
    )
      runtimeImports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch"
    )
      usesNetwork = true;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(node:)?(https?|net|tls|dns|http2)$/.test(node.moduleSpecifier.text)
    )
      usesNetwork = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { runtimeImports, usesNetwork };
}

/** Every app module the entry loads at run time, by relative imports. */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of read(file).runtimeImports) {
      if (!specifier.startsWith(".")) continue;
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return [...seen];
}

describe("the webhook handler", () => {
  // #441-T15
  it("loads no module that calls out, and calls no network function itself", () => {
    const files = closure(ENTRY);
    const relative = files.map((file) => file.slice(SRC.length + 1));

    expect(relative).toContain("billing/webhook-subscription.ts");
    expect(relative).toContain("billing/webhook-price.ts");
    for (const file of relative)
      for (const forbidden of OUTBOUND)
        expect(file.startsWith(forbidden) || file === forbidden, file).toBe(
          false,
        );
    for (const file of files) expect(read(file).usesNetwork, file).toBe(false);
  });

  // #441-T15
  it("can fail: a module that calls fetch or loads the Paddle client is recognised", () => {
    const sample = join(import.meta.dirname, "paddle-client.ts");

    expect(read(sample).usesNetwork).toBe(true);
    expect(
      closure(join(import.meta.dirname, "prices-service.ts")).map((file) =>
        file.slice(SRC.length + 1),
      ),
    ).toContain("billing/paddle-client.ts");
  });
});
