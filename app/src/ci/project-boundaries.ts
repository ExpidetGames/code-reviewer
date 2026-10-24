// SPDX-License-Identifier: LicenseRef-Proprietary

// The projects of the repository (app, runner, dispatcher) never import each other's source (#318):
// what they share is the contracts (JSON schemas, and the types generated from them into each project)
// and the fakes. The Dispatcher in particular must not reach into server-only app code (the database,
// the GitHub credentials). The check reads import specifiers, so it works without the other project's
// tooling and is the same for every language of the repository that uses these import forms.

export type ProjectName = "app" | "runner" | "dispatcher";
const PROJECTS: readonly ProjectName[] = ["app", "runner", "dispatcher"];

export type BoundaryViolation = { file: string; specifier: string };

const PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];

/** Every module specifier a source file imports, in the order it appears. */
export function importsOf(source: string): string[] {
  const found: Array<{ index: number; specifier: string }> = [];
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined)
        found.push({ index: match.index ?? 0, specifier });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.specifier);
}

/** Normalises a path built from `directory` and a relative specifier; null if it leaves the repository. */
function resolveRelative(directory: string, specifier: string): string | null {
  const parts = directory.split("/").filter((part) => part !== "");
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** The other projects' package names: importing one is importing its source. */
function packageProject(specifier: string): ProjectName | null {
  const match = /^code-reviewer-(app|runner|dispatcher)(?:\/|$)/.exec(
    specifier,
  );
  return match === null ? null : (match[1] as ProjectName);
}

/**
 * The imports of `source` (a file at the repository-relative `path`, belonging to `project`) that reach
 * the source of another project: a relative path that resolves into its folder, or its package name.
 */
export function violationsIn(
  path: string,
  source: string,
  project: ProjectName,
): BoundaryViolation[] {
  const others = PROJECTS.filter((name) => name !== project);
  const directory = path.split("/").slice(0, -1).join("/");
  return importsOf(source)
    .filter((specifier) => {
      const named = packageProject(specifier);
      if (named !== null) return named !== project;
      if (!specifier.startsWith(".")) return false;
      const resolved = resolveRelative(directory, specifier);
      if (resolved === null) return true;
      return others.some(
        (other) => resolved === other || resolved.startsWith(`${other}/`),
      );
    })
    .map((specifier) => ({ file: path, specifier }));
}
