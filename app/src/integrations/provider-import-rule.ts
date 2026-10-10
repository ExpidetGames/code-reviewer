// The import rule behind the integration boundary: platform specific code (a provider
// implementation under src/integrations/providers/) is imported by the registry and by the provider's
// own folder only. Everything else, jobs, the runner API, the UI, depends on the normalized types,
// the IntegrationProvider interface and the registry. Pure function, no file system access, so it can
// be run by a test today and by a structure check (`verify:structure`) later.
import { dirname, posix } from "node:path";

export type SourceFile = {
  /** Path relative to the app folder, for example "src/jobs/enqueue.ts". */
  path: string;
  content: string;
};

export type ProviderImportViolation = {
  file: string;
  /** The import specifier exactly as written. */
  specifier: string;
};

const PROVIDERS_DIRECTORY = "src/integrations/providers";
const REGISTRY_FILE = "src/integrations/registry.ts";

// `from "x"`, `import "x"`, `import("x")`, `require("x")`
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function withoutCommentLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

function resolveSpecifier(file: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return posix.join("src", specifier.slice(2));
  if (specifier.startsWith("."))
    return posix.join(dirname(file).split("\\").join("/"), specifier);
  return null;
}

function isInsideProviders(path: string): boolean {
  return (
    path === PROVIDERS_DIRECTORY || path.startsWith(`${PROVIDERS_DIRECTORY}/`)
  );
}

export function findProviderImportViolations(
  files: SourceFile[],
): ProviderImportViolation[] {
  const violations: ProviderImportViolation[] = [];

  for (const { path, content } of files) {
    const file = path.split("\\").join("/");
    if (file === REGISTRY_FILE || isInsideProviders(file)) continue;

    for (const match of withoutCommentLines(content).matchAll(
      SPECIFIER_PATTERN,
    )) {
      const specifier = match[1]!;
      const resolved = resolveSpecifier(file, specifier);
      if (resolved !== null && isInsideProviders(resolved))
        violations.push({ file, specifier });
    }
  }
  return violations;
}
