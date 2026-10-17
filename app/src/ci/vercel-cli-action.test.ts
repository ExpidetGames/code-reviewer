// SPDX-License-Identifier: Apache-2.0

// Pins down how the deployment workflows get the Vercel CLI (#403): from tools/vercel, the exact version in its
// package.json with the whole dependency tree from the committed package-lock.json, installed with
// `npm ci --ignore-scripts`, so that nothing the CLI pulls in floats from one run to the next (the CLI runs with the
// token) and no install script of it runs.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readText, type CompositeAction } from "./workflow-support.ts";

const manifest = JSON.parse(readText("tools/vercel/package.json")) as {
  dependencies: Record<string, string>;
  private?: boolean;
};
const lock = JSON.parse(readText("tools/vercel/package-lock.json")) as {
  lockfileVersion: number;
  packages: Record<
    string,
    { version?: string; resolved?: string; integrity?: string }
  >;
};
const action = parse(
  readText(".github/actions/vercel-cli/action.yml"),
) as CompositeAction;

describe("the Vercel CLI of the deployment workflows", () => {
  // #403-T08
  it("is one package at an exact version, in a private manifest that installs nothing else", () => {
    expect(Object.keys(manifest.dependencies)).toEqual(["vercel"]);
    expect(manifest.dependencies.vercel).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.private).toBe(true);
  });

  // #403-T08
  it("has a lockfile that resolves it to that version, with an integrity hash for every package", () => {
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
    expect(lock.packages["node_modules/vercel"]?.version).toBe(
      manifest.dependencies.vercel,
    );
    const installed = Object.entries(lock.packages).filter(
      ([path]) => path !== "",
    );
    expect(installed.length).toBeGreaterThan(50);
    for (const [path, entry] of installed) {
      if ((entry as { link?: boolean }).link) continue;
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha(256|384|512)-/);
    }
  });

  // #403-T08
  it("is installed from the lockfile with install scripts off, put on the PATH, and checked against the manifest", () => {
    const text = JSON.stringify(action.runs.steps);
    expect(text).toContain("npm ci --prefix tools/vercel --ignore-scripts");
    expect(text).toContain("tools/vercel/node_modules/.bin");
    expect(text).toContain("GITHUB_PATH");
    expect(text).toContain("dependencies.vercel");
    expect(text).not.toMatch(/npm install|@latest|secrets\./);
    for (const step of action.runs.steps)
      expect(step.run ?? "").not.toContain("${{ inputs");
  });
});
