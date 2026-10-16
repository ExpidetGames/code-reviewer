// SPDX-License-Identifier: Apache-2.0

// Pins down the project configuration for the serverless platform (app/vercel.json) and the build
// output that depends on the runtime mode (#319): the region, a cron that calls a route that exists and
// is open to the cron, durations for routes that exist, and `output: "standalone"` for the Docker image
// only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicPath } from "../auth/access.ts";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));

type VercelConfig = {
  regions?: string[];
  crons?: Array<{ path: string; schedule: string }>;
  functions?: Record<string, { maxDuration?: number }>;
} & Record<string, unknown>;

const config = JSON.parse(
  readFileSync(`${appRoot}vercel.json`, "utf8"),
) as VercelConfig;

function routeFile(path: string): string {
  return `${appRoot}src/app${path}/route.ts`;
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

describe("app/vercel.json", () => {
  // #319-T08
  it("runs in the one region the golden snapshots and the database live in", () => {
    expect(config.regions).toEqual(["fra1"]);
  });

  // #319-T08
  it("calls only routes that exist and that a cron without a session may reach, on a valid schedule", () => {
    const crons = config.crons ?? [];
    expect(crons.length).toBeGreaterThan(0);
    for (const { path, schedule } of crons) {
      expect(existsSync(routeFile(path)), `${path} has a route file`).toBe(
        true,
      );
      expect(isPublicPath(path), `${path} is open to the cron`).toBe(true);
      expect(schedule.split(" ")).toHaveLength(5);
    }
  });

  // #319-T08
  it("syncs with GitHub at most once a day", () => {
    const sync = (config.crons ?? []).filter(
      ({ path }) => path === "/api/internal/repository-sync",
    );
    expect(sync).toHaveLength(1);
    const [minute, hour, day, month] = (sync[0]?.schedule ?? "").split(" ");
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([day, month]).toEqual(["*", "*"]);
  });

  // #395-T01
  it("sweeps every two hours, once: a safety net, so the scale-to-zero database can sleep between webhooks", () => {
    const sweep = (config.crons ?? []).filter(
      ({ path }) => path === "/api/internal/dispatch-sweep",
    );
    expect(sweep).toEqual([
      { path: "/api/internal/dispatch-sweep", schedule: "0 */2 * * *" },
    ]);
  });

  // #319-T08
  it("sets a duration only for patterns that match a route file", () => {
    const files = routeFiles(`${appRoot}src/app`).map((file) =>
      file.slice(appRoot.length),
    );
    for (const [pattern, { maxDuration }] of Object.entries(
      config.functions ?? {},
    )) {
      expect(maxDuration).toBeGreaterThan(0);
      const expression = new RegExp(
        `^${pattern
          .replaceAll(".", "\\.")
          .replaceAll("**", "\u0000")
          .replaceAll("*", "[^/]*")
          .replaceAll("\u0000", ".*")}$`,
      );
      expect(
        files.some((file) => expression.test(file)),
        `${pattern} matches a route file`,
      ).toBe(true);
    }
  });
});

describe("next.config.ts output", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function outputIn(env: Record<string, string>): Promise<unknown> {
    vi.resetModules();
    for (const name of ["APP_RUNTIME", "VERCEL"]) vi.stubEnv(name, "");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    return (await import("../../next.config.ts")).default.output;
  }

  // #319-T08
  it("stays standalone for the Docker image, which is the default", async () => {
    expect(await outputIn({})).toBe("standalone");
  });

  // #319-T08
  it("leaves the output to the platform in serverless mode", async () => {
    expect(await outputIn({ APP_RUNTIME: "serverless" })).toBeUndefined();
    expect(await outputIn({ VERCEL: "1" })).toBeUndefined();
  });

  // #319-T08
  it("stays standalone when APP_RUNTIME=server overrides the platform marker", async () => {
    expect(await outputIn({ VERCEL: "1", APP_RUNTIME: "server" })).toBe(
      "standalone",
    );
  });
});
