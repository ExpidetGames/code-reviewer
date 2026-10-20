// SPDX-License-Identifier: Apache-2.0

// The scripting routes of the fake models.dev (#554), which the Playwright run uses over HTTP because the fake runs as a
// process of its own there: health, the fixture to change, and the body `/api.json` answers from then on.
import { afterEach, describe, expect, it } from "vitest";
import {
  startModelsDevFake,
  type ModelsDevFake,
} from "../../../fakes/models-dev/server.ts";

const fakes: ModelsDevFake[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

async function start() {
  const fake = await startModelsDevFake();
  fakes.push(fake);
  return { fake, base: new URL(fake.url).origin };
}

describe("the scripting routes of the fake models.dev", () => {
  // #554-T10
  it("answers its health and hands out the fixture", async () => {
    const { base } = await start();

    expect((await fetch(`${base}/__fake/health`)).status).toBe(200);
    const fixture = (await (
      await fetch(`${base}/__fake/fixture`)
    ).json()) as Record<string, unknown>;
    expect(Object.keys(fixture)).toContain("deepseek");
  });

  // #554-T10
  it("answers from then on with the body it was sent, and refuses a body that is not JSON", async () => {
    const { base, fake } = await start();

    const sent = await fetch(`${base}/__fake/respond`, {
      method: "POST",
      body: JSON.stringify({ only: {} }),
    });
    const bad = await fetch(`${base}/__fake/respond`, {
      method: "POST",
      body: "{not json",
    });

    expect(sent.status).toBe(204);
    expect(bad.status).toBe(400);
    expect(await (await fetch(fake.url)).json()).toEqual({ only: {} });
  });
});
