// SPDX-License-Identifier: LicenseRef-Proprietary

// A server under test closes a connection that stayed idle for five seconds (Node's default keep-alive timeout), and the
// client of a journey (Playwright's request context, the browser's route fetch) reuses connections: a request sent at the
// moment the server closes its end fails with `read ECONNRESET` (billing journeys, catalog journey: #714). Every
// `next start` of the e2e lanes therefore keeps idle connections longer than any pause of a journey.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("../../", import.meta.url));
const CONFIGS = [
  "playwright.config.ts",
  "playwright.hosted.config.ts",
  "playwright.dynamic.config.ts",
];

describe("the servers of the e2e lanes", () => {
  // #714-T01
  for (const file of CONFIGS)
    it(`${file} starts every app with a keep-alive timeout longer than a pause of a journey`, () => {
      const lines = readFileSync(`${appDir}${file}`, "utf8")
        .split("\n")
        .filter((line) => /(pnpm start|next start) --hostname/.test(line));

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const milliseconds = /--keepAliveTimeout (\d+)/.exec(line)?.[1];
        expect(Number(milliseconds), line).toBeGreaterThanOrEqual(60_000);
      }
    });
});
