// Pins down the import rule that keeps the platform out of the rest of the app: only the registry
// and the providers' own folder may import a provider implementation. Jobs, the runner API and the
// UI import the normalized types, the IntegrationProvider interface or the registry, nothing else.
// The last test runs the rule on the real source tree.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findProviderImportViolations,
  type SourceFile,
} from "./provider-import-rule.ts";

function file(path: string, content: string): SourceFile {
  return { path, content };
}

// The fixtures build their import statements instead of spelling them out, so that the real-tree
// test at the end does not mistake this file for a violation.
const importLine = (specifier: string) => `import x from "${specifier}";`;
const dynamicImport = (specifier: string) =>
  `const p = await import("${specifier}");`;
const reExport = (specifier: string) => `export * from "${specifier}";`;
const GITHUB = "integrations/providers/github-app";

describe("the provider import rule", () => {
  // CR-20-T06
  it("flags a job module that imports the GitHub provider and names the file", () => {
    const specifier = `../${GITHUB}/provider.ts`;

    const violations = findProviderImportViolations([
      file("src/jobs/enqueue.ts", importLine(specifier)),
    ]);

    expect(violations).toEqual([{ file: "src/jobs/enqueue.ts", specifier }]);
  });

  // CR-20-T06
  it("flags the same import through the @ alias, a dynamic import and a re-export", () => {
    const violations = findProviderImportViolations([
      file("src/app/runners/page.tsx", importLine(`@/${GITHUB}`)),
      file(
        "src/app/api/runners/claim/route.ts",
        dynamicImport(`@/${GITHUB}/provider.ts`),
      ),
      file("src/ui/index.ts", reExport(`../${GITHUB}/index.ts`)),
    ]);

    expect(violations.map((violation) => violation.file)).toEqual([
      "src/app/runners/page.tsx",
      "src/app/api/runners/claim/route.ts",
      "src/ui/index.ts",
    ]);
  });

  it("allows the registry and the providers' own folder to import a provider", () => {
    const violations = findProviderImportViolations([
      file(
        "src/integrations/registry.ts",
        importLine("./providers/github-app/index.ts"),
      ),
      file(
        "src/integrations/providers/github-app/webhook.ts",
        [importLine("./sign.ts"), importLine("../other/index.ts")].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("allows importing the interface, the normalized types and the registry from anywhere", () => {
    const violations = findProviderImportViolations([
      file(
        "src/jobs/enqueue.ts",
        [
          importLine("../integrations/types.ts"),
          importLine("@/integrations/provider.ts"),
          importLine("../integrations/registry.ts"),
          importLine("../integrations/providers-overview.ts"),
        ].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("does not count a mention in a comment as an import", () => {
    const specifier = `../${GITHUB}`;

    const violations = findProviderImportViolations([
      file(
        "src/jobs/enqueue.ts",
        [
          `// never: ${importLine(specifier)}`,
          "/*",
          ` * ${importLine(specifier)}`,
          " */",
        ].join("\n"),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("reports a violation in a test file as well", () => {
    const violations = findProviderImportViolations([
      file("src/jobs/enqueue.test.ts", importLine(`../${GITHUB}/provider.ts`)),
    ]);

    expect(violations).toHaveLength(1);
  });

  it("holds for every source file of the app", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files: SourceFile[] = [];
    for (const directory of ["src", "e2e", "integration-tests"]) {
      let entries: string[];
      try {
        entries = readdirSync(join(root, directory), {
          recursive: true,
        }) as string[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
        const path = join(directory, entry);
        files.push({ path, content: readFileSync(join(root, path), "utf8") });
      }
    }

    expect(files.length).toBeGreaterThan(10);
    expect(findProviderImportViolations(files)).toEqual([]);
  });
});
