// SPDX-License-Identifier: Apache-2.0

// The structure test of workspace scoping (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.7: "a test fails when a repository function takes no workspace"). It reads the source of
// every repository module:
//
// - each module must be classified here, as scoped or as instance level, so a new repository cannot
//   slip in unnoticed, and a classification of a module that is gone fails too;
// - in a scoped module, every exported function that is handed a database connection must take the
//   `workspaceId` too, and the module must have at least one such function (so the check cannot pass
//   because it found nothing).
//
// What the test proves is the signature. That the queries behind it really filter by the workspace
// is proven by scoped-isolation.integration.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Repositories of customer data: created for one workspace, every query filters by it. */
const SCOPED = [
  "app-settings-repository.ts",
  "installation-link-requests-repository.ts",
  "integrations-repository.ts",
  "invitations-repository.ts",
  "jobs-repository.ts",
  "projects-repository.ts",
  "repositories-repository.ts",
  "runs-repository.ts",
  "workspace-members-repository.ts",
  "workspace-secrets-repository.ts",
] as const;

/**
 * Not scoped, each for a reason that has to hold:
 * - the tables are not customer data (app_meta, allowed_login_pins, webhook_deliveries, workspaces,
 *   instance_settings, rate_limits, secrets);
 * - integration-directory: webhooks and the synchronization find a connection before the workspace is
 *   known; it only reads and the answer names the workspace;
 * - invitation-directory: a person who opens an invitation link holds only the token, and the list of the
 *   invitations that wait for an address spans workspaces; it only reads and every answer names the
 *   workspace, and whatever is done next goes through the scoped invitations repository;
 * - installation-link-request-directory: the instance admin decides the requests of every workspace to link
 *   an installation; it reads with the workspace and requester names, and its one write is the decision
 *   (a guarded statement on a request that still waits). Asking, refreshing and withdrawing go through the
 *   scoped installation-link-requests repository;
 * - unclaimed-installations: installations that no workspace has linked belong to no workspace by definition;
 * - runner-jobs: runners serve the whole instance, every statement is fenced by the lease token;
 * - jobs-claim: the one SQL statement of the runner side, not a repository;
 * - job-claimed-keys: the encrypted LLM key handed out with the claim of a job. It is keyed by the job and read
 *   only by the runner API when that job is completed (the job and its workspace are known there); it never
 *   lists, and a key is only ever looked up by the id of a job the caller holds.
 */
const INSTANCE_LEVEL = [
  "allowed-login-pins-repository.ts",
  "app-meta-repository.ts",
  "installation-link-request-directory-repository.ts",
  "instance-settings-repository.ts",
  "integration-directory-repository.ts",
  "invitation-directory-repository.ts",
  "job-claimed-keys-repository.ts",
  "jobs-claim.ts",
  "rate-limits-repository.ts",
  "runner-jobs-repository.ts",
  "secrets-repository.ts",
  "unclaimed-installations-repository.ts",
  "webhook-deliveries-repository.ts",
  "workspaces-repository.ts",
] as const;

const DIRECTORY = import.meta.dirname;

function sourceFiles(): string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .sort();
}

type ExportedFunction = {
  name: string;
  parameters: Array<{ name: string; type: string }>;
};

/** The exported functions of a module: declarations and `export const x = (...) =>`. */
function exportedFunctions(file: string): ExportedFunction[] {
  const text = readFileSync(join(DIRECTORY, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: ExportedFunction[] = [];
  const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
  const describe = (name: string, fn: ts.SignatureDeclarationBase) =>
    found.push({
      name,
      parameters: fn.parameters.map((parameter) => ({
        name: parameter.name.getText(source),
        type: parameter.type?.getText(source) ?? "",
      })),
    });

  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      describe(statement.name.text, statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        )
          describe(declaration.name.getText(source), init);
      }
  }
  return found;
}

/** An exported function that is handed a database connection (or a transaction). */
function touchesTheDatabase(fn: ExportedFunction): boolean {
  return fn.parameters.some((parameter) => parameter.type.includes("Kysely"));
}

describe("the repositories and workspace scoping", () => {
  // DM-08
  it("classifies every repository module as scoped or instance level, and nothing else", () => {
    const classified = [...SCOPED, ...INSTANCE_LEVEL].sort();

    expect(sourceFiles()).toEqual(classified);
    expect(new Set(classified).size).toBe(classified.length);
  });

  // DM-08
  it.each(SCOPED)(
    "has a factory in %s and every exported function that takes a connection also takes the workspace",
    (file) => {
      const databaseFunctions =
        exportedFunctions(file).filter(touchesTheDatabase);
      expect(
        databaseFunctions.length,
        `${file} exports no function that takes a database connection`,
      ).toBeGreaterThan(0);

      for (const fn of databaseFunctions) {
        const workspace = fn.parameters.find(
          (parameter) => parameter.name === "workspaceId",
        );
        expect(
          workspace,
          `${file}: ${fn.name} takes a database connection but no workspaceId`,
        ).toBeDefined();
        expect(workspace?.type, `${file}: ${fn.name}`).toBe("WorkspaceId");
      }
    },
  );

  // DM-08
  it("recognises a function without a workspace (the check can fail)", () => {
    const withoutWorkspace: ExportedFunction = {
      name: "createLeakyRepository",
      parameters: [
        { name: "db", type: "Kysely<Database>" },
        { name: "now", type: "() => Date" },
      ],
    };

    expect(touchesTheDatabase(withoutWorkspace)).toBe(true);
    expect(
      withoutWorkspace.parameters.some((p) => p.name === "workspaceId"),
    ).toBe(false);
  });

  it("keeps the instance level modules from taking a workspace, so the two groups stay apart", () => {
    for (const file of INSTANCE_LEVEL)
      for (const fn of exportedFunctions(file))
        expect(
          fn.parameters.map((parameter) => parameter.name),
          `${file}: ${fn.name}`,
        ).not.toContain("workspaceId");
  });
});
