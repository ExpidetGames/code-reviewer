// SPDX-License-Identifier: Apache-2.0

// No test lane reaches the internet through the models.dev catalog (#548): an app under test (an e2e server, the hosted
// sweep, the upgrade lane, a smoke container) starts the daily fetch on its own, so every environment that starts one
// must switch the fetch off (`MODELS_DEV_FETCH=off`) or point `MODELS_DEV_URL` at a fake (`fakes/models-dev`). The check
// counts the environments a file builds (each one has an anchor, the variable every app needs) against the lines that
// switch the fetch off, so a lane added later without it fails here and not in the logs of a CI run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

// The line that keeps one environment off the internet.
const TS_SWITCH = /^\s*MODELS_DEV_(FETCH: "off"|URL: )/gm;
const SH_SWITCH = /MODELS_DEV_(FETCH=off|URL=http:\/\/127\.0\.0\.1)/g;

// file → the anchor of one environment of an app under test, and what the file is.
const TS_LANES: Record<string, { anchor: RegExp; what: string }> = {
  "app/playwright.config.ts": {
    anchor: /^\s*APP_SECRET:/gm,
    what: "the shared environment of the e2e apps",
  },
  "app/playwright.hosted.config.ts": {
    anchor: /^\s*APP_SECRET:/gm,
    what: "the hosted lane (serverless: the sweep fetches)",
  },
  "app/playwright.dynamic.config.ts": {
    anchor: /^\s*APP_SECRET:/gm,
    what: "the Dynamic lane apps",
  },
  "app/e2e/helpers/upgrade-app.ts": {
    anchor: /^\s*BETTER_AUTH_URL:/gm,
    what: "the app of the upgrade lane",
  },
};
const SH_LANES: Record<string, { anchor: RegExp; what: string }> = {
  "docker/smoke/compose.sh": {
    anchor: /export BETTER_AUTH_URL=/g,
    what: "the compose smoke stack",
  },
  "docker/smoke/app.sh": {
    anchor: /--env BETTER_AUTH_URL=/g,
    what: "the image smoke container",
  },
  "docker/smoke/upgrade.sh": {
    anchor: /--env BETTER_AUTH_URL=/g,
    what: "the upgrade smoke containers (previous and new release)",
  },
};

describe("no lane reaches models.dev", () => {
  // #548-T13
  for (const [file, { anchor, what }] of Object.entries(TS_LANES))
    it(`${file} switches the catalog fetch off for every app (${what})`, () => {
      const text = read(file);
      const environments = count(text, anchor);
      expect(environments).toBeGreaterThan(0);
      expect(count(text, TS_SWITCH)).toBeGreaterThanOrEqual(environments);
    });

  // #548-T13
  for (const [file, { anchor, what }] of Object.entries(SH_LANES))
    it(`${file} switches the catalog fetch off (${what})`, () => {
      const text = read(file);
      const environments = count(text, anchor);
      expect(environments).toBeGreaterThan(0);
      expect(count(text, SH_SWITCH)).toBeGreaterThanOrEqual(environments);
    });

  // #548-T13
  it("every webServer of a Playwright config that starts the app gets the shared environment or its own switch", () => {
    // `playwright.config.ts` spreads `appEnv` into its apps; every `next start` there must do so, or it carries its own.
    const text = read("app/playwright.config.ts");
    const servers = text.split(/\n\s*\{\n\s*(?:\/\/[^\n]*\n\s*)*command:/).slice(1);
    const apps = servers.filter((server) => /pnpm start/.test(server));
    expect(apps.length).toBeGreaterThan(0);
    for (const server of apps)
      expect(server).toMatch(/\.\.\.appEnv|MODELS_DEV_FETCH: "off"/);
  });
});
