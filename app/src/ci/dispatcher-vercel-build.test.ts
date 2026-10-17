// SPDX-License-Identifier: Apache-2.0

// Pins down what keeps the Dispatcher buildable by the Vercel CLI (#412). The deployment runs `vercel build`, whose Hono
// builder type-checks through a language service that finds `undici-types` (imported by @types/node for the global
// `Response`) the way `node` does: next to the file that imports it, or in a node_modules above. pnpm keeps it only
// beside the real @types/node, so without a direct dependency every use of `Response` fails to compile there while
// `tsc` is green. The CI job "Dispatcher: static & tests" runs the same `vercel build` offline.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readText, readWorkflow, stepsOf } from "./workflow-support.ts";

describe("the Dispatcher build with the Vercel CLI", () => {
  // #412-T03
  it("depends directly on the undici-types version that @types/node uses", () => {
    const manifest = JSON.parse(readText("dispatcher/package.json")) as {
      devDependencies?: Record<string, string>;
    };
    const lock = parse(readText("dispatcher/pnpm-lock.yaml")) as {
      snapshots: Record<string, { dependencies?: Record<string, string> }>;
    };
    const typesNode = Object.entries(lock.snapshots).filter(([key]) =>
      key.startsWith("@types/node@"),
    );
    expect(typesNode).toHaveLength(1);
    const used = typesNode[0]?.[1].dependencies?.["undici-types"];
    expect(used).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies?.["undici-types"]).toBe(used);
  });

  // #412-T02
  it("runs in the Dispatcher lane of CI with the pinned CLI, a stub project file and neither a secret nor a token", () => {
    const job = readWorkflow("ci.yml").jobs["dispatcher-fast"];
    if (!job) throw new Error("no job dispatcher-fast");
    const steps = stepsOf(job);
    const install = steps.findIndex(
      (step) => step.uses === "./.github/actions/vercel-cli",
    );
    const build = steps.findIndex((step) => step.run?.includes("vercel build"));
    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(install);
    // The dependencies are installed before the CLI builds from them.
    expect(
      steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile"),
    ).toBeLessThan(install);
    const run = steps[build]?.run ?? "";
    expect(run).toContain("vercel build --prod --yes");
    expect(run).toContain('"framework":"hono"');
    expect(run).not.toMatch(/--token|VERCEL_TOKEN|secrets\./);
    expect(JSON.stringify(steps[build]?.env ?? {})).not.toMatch(
      /secrets\.|TOKEN/,
    );
    expect(steps[build]?.["continue-on-error"]).toBeUndefined();
  });
});
