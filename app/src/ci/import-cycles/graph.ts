// SPDX-License-Identifier: LicenseRef-Proprietary

// The import graph of `app/src` and its cycles (#715). Packages can only be cut out of `app/src` along
// edges that point one way, so a cycle between files, and between top-level modules, is what stands in
// the way. `ALLOWED_*` (`allow-list.ts`) names the cycles that exist today; the check fails for every
// cycle that is not on the list and for every entry that is no longer a cycle, so the list only shrinks.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

/** file (relative to `src`) -> the files of `src` it imports. Type-only imports count: a package needs them too. */
export type FileGraph = ReadonlyMap<string, ReadonlySet<string>>;

const SOURCE = /\.(ts|tsx|mts)$/;
const TEST_FILE = /\.(test|integration\.test)\.(ts|tsx|mts)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts"];

function isProductionSource(path: string): boolean {
  if (!SOURCE.test(path) || path.endsWith(".d.ts")) return false;
  if (TEST_FILE.test(path)) return false;
  return !path.startsWith("test-support/");
}

function listSources(src: string, directory = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(src, directory), {
    withFileTypes: true,
  })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listSources(src, path));
    else if (isProductionSource(path)) found.push(path);
  }
  return found;
}

/** The file a specifier of `from` names inside `src`, or null for a package, an asset or a path outside `src`. */
export function resolveSpecifier(
  specifier: string,
  from: string,
  files: ReadonlySet<string>,
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) base = join(dirname(from), specifier);
  else return null;
  base = base.replace(/\/+$/, "");
  const candidates = [
    base,
    base.replace(/\.m?js$/, ".ts"),
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/** Every module specifier of a source file: static, re-exported, dynamic `import()` and `require()`. */
export function specifiersOf(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => specifier !== "");
}

export function buildFileGraph(
  sources: ReadonlyMap<string, string>,
): FileGraph {
  const files = new Set(sources.keys());
  const graph = new Map<string, Set<string>>();
  for (const [path, source] of sources) {
    const imports = new Set<string>();
    for (const specifier of specifiersOf(source)) {
      const target = resolveSpecifier(specifier, path, files);
      if (target !== null && target !== path) imports.add(target);
    }
    graph.set(path, imports);
  }
  return graph;
}

/** The graph of the production code under `src` (no tests, no `test-support`). */
export function readFileGraph(src: string): FileGraph {
  const sources = new Map<string, string>();
  for (const path of listSources(src))
    sources.set(path, readFileSync(join(src, path), "utf8"));
  return buildFileGraph(sources);
}

/** Strongly connected components of two or more nodes (Tarjan, iterative), each sorted, the list sorted. */
export function cyclicGroups(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;

  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: Iterator<string> }> = [];
    const enter = (node: string) => {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: (graph.get(node) ?? new Set()).values() });
    };
    enter(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const step = frame.next.next();
      if (step.done !== true) {
        const target = step.value;
        if (!index.has(target)) enter(target);
        else if (onStack.has(target))
          low.set(
            frame.node,
            Math.min(low.get(frame.node) ?? 0, index.get(target) ?? 0),
          );
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined)
        low.set(
          parent.node,
          Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0),
        );
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const group: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        group.push(member);
      } while (member !== frame.node);
      if (group.length > 1) groups.push(group.sort());
    }
  }
  return groups.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

/** A shortest import path from `from` back to `to`, for the message of a violation. */
export function pathBetween(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  to: string,
): string[] {
  const previous = new Map<string, string>();
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    for (const next of graph.get(node) ?? []) {
      if (next === from || previous.has(next)) continue;
      previous.set(next, node);
      if (next === to) {
        const path = [to];
        for (let at = to; at !== from;) {
          at = previous.get(at) ?? from;
          path.unshift(at);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}

/** The top-level module of a file: its first directory under `src`; a file directly in `src` is a module of its own. */
export function moduleOf(file: string): string {
  const slash = file.indexOf("/");
  return slash === -1 ? file : file.slice(0, slash);
}

export type ModuleEdge = { edge: string; example: string };

/** Edges between different modules as "from -> to", each with one file that causes it. */
export function moduleGraph(graph: FileGraph): {
  graph: Map<string, Set<string>>;
  examples: Map<string, string>;
} {
  const modules = new Map<string, Set<string>>();
  const examples = new Map<string, string>();
  for (const [file, imports] of graph) {
    const from = moduleOf(file);
    if (!modules.has(from)) modules.set(from, new Set());
    for (const target of imports) {
      const to = moduleOf(target);
      if (to === from) continue;
      if (!modules.has(to)) modules.set(to, new Set());
      modules.get(from)?.add(to);
      const key = `${from} -> ${to}`;
      if (!examples.has(key)) examples.set(key, `${file} -> ${target}`);
    }
  }
  return { graph: modules, examples };
}

/** The module edges that lie on a cycle: both ends in one strongly connected component of the module graph. */
export function cyclicModuleEdges(graph: FileGraph): ModuleEdge[] {
  const { graph: modules, examples } = moduleGraph(graph);
  const component = new Map<string, number>();
  cyclicGroups(modules).forEach((group, number) => {
    for (const name of group) component.set(name, number);
  });
  const edges: ModuleEdge[] = [];
  for (const [from, targets] of modules) {
    for (const to of targets) {
      const inside = component.get(from);
      if (inside === undefined || inside !== component.get(to)) continue;
      const edge = `${from} -> ${to}`;
      edges.push({ edge, example: examples.get(edge) ?? "" });
    }
  }
  return edges.sort((a, b) => a.edge.localeCompare(b.edge));
}

export type AllowList = {
  /** Files that may sit in an import cycle between files, one sorted group per strongly connected component. */
  fileGroups: readonly (readonly string[])[];
  /** Imports between two top-level modules that may lie on a cycle of modules, as "from -> to". */
  moduleEdges: readonly string[];
};

/** What the check found beyond or short of the allow-list; empty means the list is exact. */
export function checkImportCycles(
  graph: FileGraph,
  allowed: AllowList,
): string[] {
  const problems: string[] = [];

  const allowedFiles = new Set(allowed.fileGroups.flat());
  const groups = cyclicGroups(graph);
  const cyclicFiles = new Set(groups.flat());
  for (const group of groups) {
    const first = group[0] ?? "";
    const listed = allowed.fileGroups.some((candidate) =>
      group.every((file) => candidate.includes(file)),
    );
    if (listed) continue;
    const unlisted = group.filter((file) => !allowedFiles.has(file));
    const second = group.find((file) => graph.get(first)?.has(file)) ?? first;
    const cycle = [first, ...pathBetween(graph, second, first)].join(" -> ");
    problems.push(
      `new import cycle between files (${group.length} files, not on the allow-list: ${unlisted.join(", ") || "the group is a union of listed groups"}), for example ${cycle}`,
    );
  }
  for (const file of allowedFiles)
    if (!cyclicFiles.has(file))
      problems.push(
        `${file} is on the file cycle allow-list but is no longer in a cycle: remove it from fileGroups`,
      );

  const found = cyclicModuleEdges(graph);
  const listedEdges = new Set(allowed.moduleEdges);
  const foundEdges = new Set(found.map((edge) => edge.edge));
  for (const { edge, example } of found)
    if (!listedEdges.has(edge))
      problems.push(
        `new import between modules that already depend on each other: ${edge} (for example ${example})`,
      );
  for (const edge of listedEdges)
    if (!foundEdges.has(edge))
      problems.push(
        `${edge} is on the module cycle allow-list but is no longer on a cycle: remove it from moduleEdges`,
      );
  return problems;
}
