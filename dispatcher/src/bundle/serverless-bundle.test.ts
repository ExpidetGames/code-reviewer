// SPDX-License-Identifier: Apache-2.0

// The serverless bundle (#327-T09): what Vercel builds from src/index.ts must hold no process spawning.
// The bundle is made here with rolldown (in memory, nothing is written), the same way a platform bundler
// follows the import graph: a module reached from the entry is in the bundle, whether it is used or not.
import { join } from "node:path";
import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const FORBIDDEN = ["child_process", "node:cluster", "node:worker_threads"];

// Two packages of the Sandbox SDK's dependency tree mention a forbidden name. They are left out of the bundle under
// test, each only when it is imported by the one package that is known to import it, so that everything else in the
// graph is still checked, and a second path to them (a new SDK version, our own import) is not hidden. Neither runs
// on the platform:
//   execa (and cross-spawn below it)  imported by @vercel/cli-exec, which @vercel/oidc (a dependency of
//                                     @vercel/sandbox) uses on a developer machine without an OIDC token to run the
//                                     Vercel CLI and fetch one; on the platform the token is given.
//   undici                            imported by @vercel/sandbox, the SDK's HTTP client; it feature-detects
//                                     worker_threads and uses it for nothing we call.
const ACCEPTED_EXTERNALS: Readonly<Record<string, string>> = {
  execa: "@vercel/cli-exec",
  undici: "@vercel/sandbox",
};

/** Whether `source`, imported by the file `importer`, is one of the accepted externals above. */
export function isAcceptedExternal(source: string, importer?: string): boolean {
  const owner = ACCEPTED_EXTERNALS[source];
  return (
    owner !== undefined &&
    importer !== undefined &&
    importer.includes(`/node_modules/${owner}/`)
  );
}

async function bundleOf(entry: string): Promise<{
  modules: string[];
  code: string;
  externals: string[];
}> {
  const externals = new Set<string>();
  const bundle = await rolldown({
    input: entry,
    platform: "node",
    // Node's own modules stay imports; the check below reads them from the chunk.
    external: (source, importer) => {
      if (/^node:/.test(source)) return true;
      if (!isAcceptedExternal(source, importer)) return false;
      externals.add(source);
      return true;
    },
    logLevel: "silent",
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const modules = new Set<string>();
  let code = "";
  for (const chunk of output) {
    if (chunk.type !== "chunk") continue;
    code += `${chunk.code}\n`;
    for (const id of chunk.moduleIds) modules.add(id);
    for (const imported of chunk.imports) modules.add(imported);
  }
  return { modules: [...modules], code, externals: [...externals].sort() };
}

function offenders(bundle: { modules: string[]; code: string }): string[] {
  return FORBIDDEN.filter(
    (name) =>
      bundle.modules.some((path) => path.includes(name)) ||
      bundle.code.includes(name),
  );
}

describe("the serverless bundle", () => {
  // #327-T09
  it("contains no node:child_process, and the Node entry is not part of it", async () => {
    const bundle = await bundleOf(join(ROOT, "src", "index.ts"));

    expect(bundle.code).toContain("hono");
    expect(offenders(bundle)).toStrictEqual([]);
    expect(bundle.modules.some((path) => path.endsWith("src/node.ts"))).toBe(
      false,
    );
    expect(
      bundle.modules.some((path) => path.includes("@hono/node-server")),
    ).toBe(false);
  });

  // #329-R07
  it("leaves out exactly execa and undici, and only as imported by the packages that are known to import them", async () => {
    const bundle = await bundleOf(join(ROOT, "src", "index.ts"));

    expect(bundle.externals).toStrictEqual(["execa", "undici"]);
  });

  // #329-R07
  it("accepts an external only from its known importer", () => {
    const store = "/x/node_modules/.pnpm/p@1/node_modules";
    expect(
      isAcceptedExternal("execa", `${store}/@vercel/cli-exec/dist/exec.js`),
    ).toBe(true);
    expect(
      isAcceptedExternal("undici", `${store}/@vercel/sandbox/dist/index.js`),
    ).toBe(true);
    // Our own code, another package, or the other package's importer is not accepted.
    expect(isAcceptedExternal("execa", "/repo/dispatcher/src/index.ts")).toBe(
      false,
    );
    expect(
      isAcceptedExternal("execa", `${store}/@vercel/sandbox/dist/index.js`),
    ).toBe(false);
    expect(
      isAcceptedExternal("undici", `${store}/@vercel/cli-exec/dist/exec.js`),
    ).toBe(false);
    expect(isAcceptedExternal("undici", `${store}/hono/dist/index.js`)).toBe(
      false,
    );
    expect(isAcceptedExternal("execa", undefined)).toBe(false);
    expect(
      isAcceptedExternal(
        "cross-spawn",
        `${store}/@vercel/cli-exec/dist/exec.js`,
      ),
    ).toBe(false);
  });

  // #329 (additional): the Sandbox-Launcher is in the serverless bundle, the SDK adapter with it
  it("contains the Sandbox-Launcher and its platform adapter", async () => {
    const bundle = await bundleOf(join(ROOT, "src", "index.ts"));

    for (const file of [
      "launchers/sandbox.ts",
      "launchers/sandbox-host.ts",
      "launchers/vercel-sandbox.ts",
      "launchers/container.ts",
    ])
      expect(bundle.modules.some((path) => path.endsWith(file))).toBe(true);
  });

  // #327-T09
  it("is checked by a detector that does find a spawn when one is in the graph", async () => {
    const bundle = await bundleOf(
      join(ROOT, "src", "bundle", "fixtures", "spawns.ts"),
    );

    expect(offenders(bundle)).toContain("child_process");
  });
});
