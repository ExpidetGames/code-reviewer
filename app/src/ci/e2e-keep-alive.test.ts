// SPDX-License-Identifier: LicenseRef-Proprietary

// A server under test closes a connection that stayed idle for five seconds (Node's default keep-alive timeout), and the
// client of a journey (Playwright's request context, the browser's route fetch) reuses connections: a request sent at the
// moment the server closes its end fails with `read ECONNRESET` (billing journeys, catalog journey: #714). Every
// `next start` of the e2e lanes therefore keeps idle connections longer than any pause of a journey.
import { readFileSync } from "node:fs";
import { Agent, createServer, get } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startDispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { startGithubFake } from "../../../fakes/github/server.ts";
import {
  FAKE_KEEP_ALIVE_TIMEOUT_MS,
  keepConnectionsOpen,
} from "../../../fakes/keep-alive.ts";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { startModelsDevFake } from "../../../fakes/models-dev/server.ts";
import { startStripeFake } from "../../../fakes/stripe/server.ts";

const appDir = fileURLToPath(new URL("../../", import.meta.url));
const fakesDir = fileURLToPath(new URL("../../../fakes/", import.meta.url));
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

/** The `Keep-Alive: timeout=<seconds>` a server announces on a response to a keep-alive request, which is its keepAliveTimeout. */
async function announcedKeepAliveSeconds(origin: string): Promise<number> {
  const agent = new Agent({ keepAlive: true });
  try {
    const header = await new Promise<string | undefined>((resolve, reject) => {
      get(`${origin}/__fake/health`, { agent }, (response) => {
        response.resume();
        response.on("end", () => {
          resolve(String(response.headers["keep-alive"] ?? ""));
        });
      }).on("error", reject);
    });
    return Number(/timeout=(\d+)/.exec(header ?? "")?.[1]);
  } finally {
    agent.destroy();
  }
}

type Started = { origin: string; close(): Promise<void> };

describe("the fakes the e2e lanes call directly", () => {
  const FAKES: Array<[string, () => Promise<Started>]> = [
    [
      "GitHub",
      async () => {
        const fake = await startGithubFake({});
        return { origin: fake.baseUrl, close: () => fake.close() };
      },
    ],
    [
      "LLM",
      async () => {
        const fake = await startLlmFake();
        return {
          origin: new URL(fake.baseUrl).origin,
          close: () => fake.close(),
        };
      },
    ],
    [
      "Stripe",
      async () => {
        const fake = await startStripeFake();
        return { origin: fake.baseUrl, close: () => fake.close() };
      },
    ],
    [
      "models.dev",
      async () => {
        const fake = await startModelsDevFake();
        return { origin: new URL(fake.url).origin, close: () => fake.stop() };
      },
    ],
    [
      "Dispatcher app",
      async () => {
        const fake = await startDispatcherAppFake();
        return { origin: fake.url, close: () => fake.close() };
      },
    ],
  ];

  // #714-T01
  it.each(FAKES)(
    "the %s fake keeps an idle connection open for more than a pause of a journey, and its headers timeout is longer",
    async (_name, start) => {
      const fake = await start();
      try {
        expect(
          await announcedKeepAliveSeconds(fake.origin),
        ).toBeGreaterThanOrEqual(60);
      } finally {
        await fake.close();
      }
    },
  );

  // #714-T01
  it("the shared helper sets a headers timeout above the keep-alive timeout, which Node requires", () => {
    const server = keepConnectionsOpen(createServer());

    expect(server.keepAliveTimeout).toBe(FAKE_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(60_000);
  });

  // #714-T01
  it("the SMTP fake's control server and every HTTP fake use the helper", () => {
    for (const file of [
      "github/server.ts",
      "llm/server.ts",
      "stripe/server.ts",
      "models-dev/server.ts",
      "dispatcher-app/server.ts",
      "smtp/main.ts",
    ])
      expect(readFileSync(`${fakesDir}${file}`, "utf8"), file).toMatch(
        /keepConnectionsOpen\(\w+\);/,
      );
  });
});
