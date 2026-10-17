// SPDX-License-Identifier: Apache-2.0

// The Vercel project settings of the Dispatcher (vercel.json, #329). The supervision that stops a job's VM when its
// container ends is work held in `waitUntil`, so it lives as long as the function may: `maxDuration` is set here on
// purpose, as high as a Pro team can, and the region is the one the Sandbox VMs and snapshots are in.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "./config.ts";
import { REAP_PATH } from "./reaper/route.ts";

const ROOT = join(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
  regions?: string[];
  functions?: Record<string, { maxDuration?: number }>;
  crons?: Array<{ path: string; schedule: string }>;
  git?: { deploymentEnabled?: boolean };
};

// 800 s is generally available on Pro; up to 1800 s (30 minutes) is an extended maximum in beta for Pro and
// Enterprise, set per function, on Node.js 22 or 24 (vercel.com/docs/functions/configuring-functions/duration).
const PRO_EXTENDED_MAXIMUM_SECONDS = 1800;

describe("vercel.json of the Dispatcher", () => {
  // #403-T10
  it("switches Git auto-deploy off: the project is deployed by the production workflow and by nothing else", () => {
    expect(config.git).toStrictEqual({ deploymentEnabled: false });
  });

  // #329-R08
  it("runs the function in fra1, the region of the Sandbox VMs and snapshots", () => {
    expect(config.regions).toStrictEqual(["fra1"]);
  });

  // #329-R08
  it("sets the maximum duration of the entry's function explicitly, as high as Pro allows", () => {
    const entries = Object.entries(config.functions ?? {});

    expect(entries.map(([file]) => file)).toStrictEqual(["src/index.ts"]);
    expect(existsSync(join(ROOT, "src", "index.ts"))).toBe(true);
    expect(entries[0]?.[1].maxDuration).toBe(PRO_EXTENDED_MAXIMUM_SECONDS);
  });

  // #329-R08
  it("lets the function outlive a job of the default timeout plus its launch", () => {
    const { core } = loadSettings({
      RUNNER_API_URL: "http://127.0.0.1:9",
      RUNNER_TOKEN: "dummy-dispatcher-token-for-tests",
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: "k1",
      DISPATCHER_SIGNING_SECRET: "dummy-signing-secret-current-0000000000",
    });

    expect(
      core.jobTimeoutSeconds + core.launchDeadlineSeconds,
    ).toBeLessThanOrEqual(PRO_EXTENDED_MAXIMUM_SECONDS);
  });

  // #364-T19
  it("calls the reaper's route by cron, at least every five minutes, and nothing else", () => {
    const crons = config.crons ?? [];

    expect(crons.map((cron) => cron.path)).toStrictEqual([REAP_PATH]);
    const every = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(crons[0]?.schedule ?? "");
    expect(every, `schedule ${crons[0]?.schedule}`).not.toBeNull();
    expect(Number(every?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(every?.[1])).toBeLessThanOrEqual(5);
  });

  // #416-T04
  it("gives the Hono builder exactly one entry, and it is src/index.ts", () => {
    // The wrapper builder of the Vercel CLI (@vercel/hono) takes the entry from the files app, index and server in the
    // project root and in src/ (any JS or TS extension): the first one whose text imports "hono", in that order. A file
    // that imports Hono but default-exports no app (src/app.ts did) wins over the real entry and the function dies on
    // its first request. The rule is repeated here so that this fails without the CLI.
    const names = [
      "app",
      "index",
      "server",
      "src/app",
      "src/index",
      "src/server",
    ];
    const extensions = ["js", "cjs", "mjs", "ts", "cts", "mts"];
    const importsHono =
      /(?:from|require|import)\s*(?:\(\s*)?["']hono["']\s*(?:\))?/;
    const entries = names
      .flatMap((name) => extensions.map((extension) => `${name}.${extension}`))
      .filter((file) => existsSync(join(ROOT, file)))
      .filter((file) =>
        importsHono.test(readFileSync(join(ROOT, file), "utf8")),
      );

    expect(entries).toStrictEqual(["src/index.ts"]);
  });

  // #416-T05
  it("emits the relative imports of the sources as .js, as the file-by-file build of the platform needs", () => {
    const tsconfig = JSON.parse(
      readFileSync(join(ROOT, "tsconfig.json"), "utf8"),
    ) as {
      compilerOptions: Record<string, unknown>;
    };

    expect(tsconfig.compilerOptions.rewriteRelativeImportExtensions).toBe(true);
  });
});
