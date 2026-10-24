// SPDX-License-Identifier: LicenseRef-Proprietary

// Fetching the body (#548): a size cap before parsing, a time limit, no redirect, and a stable code for each way it can
// fail. Runs against the models.dev fake on loopback; nothing leaves the machine.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startModelsDevFake,
  type ModelsDevFake,
} from "../../../fakes/models-dev/server.ts";
import { fetchModelsDev } from "./fetch.ts";

let fake: ModelsDevFake;
beforeEach(async () => {
  fake = await startModelsDevFake();
});
afterEach(async () => {
  await fake.stop();
});

const SMALL = { maxBytes: 64 * 1024, timeoutMs: 2000 };

describe("fetching the models.dev body", () => {
  // #548-T01
  it("reads a JSON body", async () => {
    fake.respondWith({ deepseek: { models: {} } });

    const result = await fetchModelsDev({
      url: fake.url,
      maxBytes: 1024 * 1024,
      timeoutMs: 2000,
    });

    expect(result).toEqual({ ok: true, body: { deepseek: { models: {} } } });
    expect(fake.requests).toBe(1);
  });

  // #548-T04
  it.each([500, 503, 429, 404])(
    "fails with a stable code for a %i answer",
    async (status) => {
      fake.respondWithStatus(status);

      expect(await fetchModelsDev({ url: fake.url, ...SMALL })).toEqual({
        ok: false,
        code: "models_dev_http_status",
      });
    },
  );

  // #548-T04
  it("does not follow a redirect, which would send the request somewhere else", async () => {
    fake.respondWithStatus(302, { location: "http://127.0.0.1:1/elsewhere" });

    expect(await fetchModelsDev({ url: fake.url, ...SMALL })).toEqual({
      ok: false,
      code: "models_dev_http_status",
    });
  });

  // #548-T04
  it("fails with a stable code for a body that is not JSON", async () => {
    fake.respondWithText("<html>Bad gateway</html>");

    expect(await fetchModelsDev({ url: fake.url, ...SMALL })).toEqual({
      ok: false,
      code: "models_dev_invalid_json",
    });
  });

  // #548-T02
  it("stops reading a body that is larger than the cap, however it is announced", async () => {
    fake.respondWithOversize(10 * 1024 * 1024);

    const result = await fetchModelsDev({
      url: fake.url,
      maxBytes: 128 * 1024,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: false, code: "models_dev_too_large" });
  });

  // #548-T02
  it("refuses at once a body whose announced length is above the cap", async () => {
    fake.respondWithText("x".repeat(200_000));

    const result = await fetchModelsDev({
      url: fake.url,
      maxBytes: 100_000,
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: false, code: "models_dev_too_large" });
  });

  // #548-T04
  it("gives up when nothing answers in time", async () => {
    fake.hang();

    const result = await fetchModelsDev({
      url: fake.url,
      maxBytes: 1024,
      timeoutMs: 150,
    });

    expect(result).toEqual({ ok: false, code: "models_dev_unreachable" });
  });

  // #548-T04
  it("reports a connection that cannot be made, without naming the address", async () => {
    const url = fake.url;
    await fake.stop();

    const result = await fetchModelsDev({ url, ...SMALL });

    expect(result).toEqual({ ok: false, code: "models_dev_unreachable" });
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    fake = await startModelsDevFake();
  });
});
