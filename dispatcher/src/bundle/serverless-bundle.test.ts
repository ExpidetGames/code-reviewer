// SPDX-License-Identifier: Apache-2.0

// The serverless bundle (#327-T09): what Vercel builds from src/index.ts must hold no process spawning.
// The bundle is made here with rolldown (in memory, nothing is written), the same way a platform bundler
// follows the import graph: a module reached from the entry is in the bundle, whether it is used or not.
import { join } from "node:path";
import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const FORBIDDEN = ["child_process", "node:cluster", "node:worker_threads"];

// Packages of the Sandbox SDK's dependency tree that mention a forbidden name, left out of the bundle under test so
// that everything else in the graph is still checked, and reached only through the package named here. None of
// them runs on the platform:
//   execa (via cross-spawn)  @vercel/sandbox -> @vercel/oidc -> @vercel/cli-exec: on a developer machine without an
//                            OIDC token it runs the Vercel CLI to fetch one; on the platform the token is given.
//   undici                   the SDK's HTTP client feature-detects worker_threads and uses it for nothing we call.
const SDK_DEPENDENCIES = ["execa", "undici"];

async function bundleOf(
  entry: string,
): Promise<{ modules: string[]; code: string }> {
  const bundle = await rolldown({
    input: entry,
    platform: "node",
    // Node's own modules stay imports; the check below reads them from the chunk.
    external: [/^node:/, ...SDK_DEPENDENCIES],
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
  return { modules: [...modules], code };
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
