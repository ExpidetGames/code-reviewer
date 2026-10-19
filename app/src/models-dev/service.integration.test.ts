// SPDX-License-Identifier: Apache-2.0

// A fetch against the models.dev fake and a real database, on both engines (#548): a first fetch fills the tables, a
// second with a changed price updates, a vanished model is unlisted and comes back, a failed or implausible fetch keeps the
// old rows, a poisoned address never becomes usable, and a switched-off fetch does nothing.
import { afterEach, describe, expect, it } from "vitest";
import {
  modelsDevFixture,
  startModelsDevFake,
  type ModelsDevFake,
} from "../../../fakes/models-dev/server.ts";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { MODELS_DEV_ENGINES } from "../test-support/models-dev-engines.ts";
import type { FetchLike } from "./fetch.ts";
import type { ModelsDevSettings } from "./settings.ts";
import { createModelsDevService } from "./service.ts";
import { isUsable, type HostResolver } from "./upstream-url.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T1 = new Date("2026-10-19T03:00:00.000Z");
const PUBLIC: HostResolver = async () => ["93.184.216.34"];

const fakes: ModelsDevFake[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

type Body = Record<
  string,
  { api?: string; models: Record<string, Record<string, unknown>> }
>;

describe.each(MODELS_DEV_ENGINES)("the models.dev fetch on $name", (engine) => {
  const it_ = engine.skip ? it.skip : it;

  async function setup(
    options: {
      resolveHost?: HostResolver;
      settings?: Partial<ModelsDevSettings>;
      timeoutMs?: number;
      maxBytes?: number;
      deadlineMs?: number;
      writeReserveMs?: number;
      lookupConcurrency?: number;
      clock?: () => number;
      /** Wraps the real fetch; gets the repository so that a test can look at the database while a fetch is made. */
      fetchWith?: (
        repository: ReturnType<typeof createModelsDevRepository>,
      ) => FetchLike;
    } = {},
  ) {
    const fake = await startModelsDevFake();
    fakes.push(fake);
    const { db } = await engine.create();
    const repository = createModelsDevRepository(db);
    let now = T1;
    const lines: string[] = [];
    const service = createModelsDevService({
      db,
      repository,
      settings: () => ({
        enabled: true,
        url: fake.url,
        warnings: [],
        ...options.settings,
      }),
      resolveHost: options.resolveHost ?? PUBLIC,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.deadlineMs === undefined
        ? {}
        : { deadlineMs: options.deadlineMs }),
      ...(options.writeReserveMs === undefined
        ? {}
        : { writeReserveMs: options.writeReserveMs }),
      ...(options.lookupConcurrency === undefined
        ? {}
        : { lookupConcurrency: options.lookupConcurrency }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.fetchWith === undefined
        ? {}
        : { fetchImpl: options.fetchWith(repository) }),
      now: () => now,
      log: {
        info: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });
    return {
      fake,
      db,
      repository,
      service,
      lines,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
      body: () => modelsDevFixture() as Body,
    };
  }

  // #548-T03
  it_("fills the tables on a first fetch", async () => {
    const t = await setup();

    const outcome = await t.service.refresh();

    expect(outcome).toMatchObject({ status: "applied" });
    const providers = await t.repository.listProviders();
    expect(providers.map((p) => p.id)).toEqual([
      "anthropic",
      "deepseek",
      "google",
      "openai",
      "openrouter",
      "xai",
    ]);
    expect(providers.every((p) => isUsable(p.url))).toBe(true);
    expect((await t.repository.listModels()).length).toBe(13);
    const state = await t.repository.fetchState();
    expect(state).toMatchObject({
      lastStatus: "ok",
      lastError: null,
      lastAttemptAt: T1.toISOString(),
      lastSuccessAt: T1.toISOString(),
    });
    expect(state?.lastSummary).toMatchObject({ models: 13, newModels: 13 });
  });

  // #548-T03
  it_(
    "stores the base address of a provider that states none from the file of the pinned SDKs",
    async () => {
      const t = await setup();

      await t.service.refresh();

      expect(
        (await t.repository.getProvider("anthropic"))?.url.trustedUrl,
      ).toBe("https://api.anthropic.com/v1");
      expect((await t.repository.getProvider("deepseek"))?.url.trustedUrl).toBe(
        "https://api.deepseek.com",
      );
    },
  );

  // #548-T03
  it_(
    "updates a changed price on a second fetch, unlists a model that vanished and clears it when it returns",
    async () => {
      const t = await setup();
      await t.service.refresh();
      const firstSeen = (
        await t.repository.getModel("deepseek", "deepseek-v4-pro")
      )?.firstSeenAt;

      t.advance(DAY);
      const changed = t.body();
      const pro = changed.deepseek?.models["deepseek-v4-pro"] as {
        cost: { input: number };
      };
      pro.cost.input = 9.5;
      t.fake.respondWith(changed);
      await t.service.refresh();
      const updated = await t.repository.getModel(
        "deepseek",
        "deepseek-v4-pro",
      );
      expect(updated?.cost?.input).toBe("9.5");
      expect(updated?.firstSeenAt).toBe(firstSeen);
      expect(updated?.updatedAt).toBe(
        new Date(T1.getTime() + DAY).toISOString(),
      );

      t.advance(DAY);
      const vanished = t.body();
      delete vanished.deepseek?.models["deepseek-v4-flash-vision-exp"];
      t.fake.respondWith(vanished);
      await t.service.refresh();
      const gone = await t.repository.getModel(
        "deepseek",
        "deepseek-v4-flash-vision-exp",
      );
      expect(gone?.unlistedAt).toBe(
        new Date(T1.getTime() + 2 * DAY).toISOString(),
      );
      expect(gone?.name).toBeTruthy();
      expect(gone?.cost).not.toBeNull();

      t.advance(DAY);
      t.fake.respondWith(t.body());
      await t.service.refresh();
      const back = await t.repository.getModel(
        "deepseek",
        "deepseek-v4-flash-vision-exp",
      );
      expect(back?.unlistedAt).toBeNull();
      expect(back?.firstSeenAt).toBe(T1.toISOString());
      expect((await t.repository.listModels()).length).toBe(13);
    },
  );

  // #548-T03
  it_(
    "stores a deprecated status as a warning and keeps the model",
    async () => {
      const t = await setup();

      await t.service.refresh();

      const model = await t.repository.getModel(
        "deepseek",
        "deepseek-v4-flash",
      );
      expect(model?.status).toBe("deprecated");
      expect(model?.unlistedAt).toBeNull();
    },
  );

  // #548-T04
  it_.each([
    [
      "a 500 answer",
      (fake: ModelsDevFake) => fake.respondWithStatus(500),
      "models_dev_http_status",
    ],
    [
      "a body that is no JSON",
      (fake: ModelsDevFake) => fake.respondWithText("<html>no</html>"),
      "models_dev_invalid_json",
    ],
    [
      "a body that is no catalog",
      (fake: ModelsDevFake) => fake.respondWith([1, 2, 3]),
      "models_dev_invalid_body",
    ],
    [
      "an empty catalog",
      (fake: ModelsDevFake) => fake.respondWith({}),
      "models_dev_invalid_body",
    ],
  ] as const)(
    "keeps the previous rows and records the code when it gets %s",
    async (_name, script, code) => {
      const t = await setup();
      await t.service.refresh();
      const before = await t.repository.listModels();
      t.advance(DAY);
      script(t.fake);

      const outcome = await t.service.refresh();

      expect(outcome).toEqual({ status: "failed", code });
      expect(await t.repository.listModels()).toEqual(before);
      expect(await t.repository.fetchState()).toMatchObject({
        lastStatus: "failed",
        lastError: code,
        lastAttemptAt: new Date(T1.getTime() + DAY).toISOString(),
        lastSuccessAt: T1.toISOString(),
      });
      expect(t.lines.join("\n")).toContain(code);
    },
  );

  // #548-T04
  it_("keeps the previous rows when nothing answers in time", async () => {
    const t = await setup({ timeoutMs: 150 });
    await t.service.refresh();
    const before = await t.repository.listModels();
    t.advance(DAY);
    t.fake.hang();

    const outcome = await t.service.refresh();

    expect(outcome).toEqual({
      status: "failed",
      code: "models_dev_unreachable",
    });
    expect(await t.repository.listModels()).toEqual(before);
    expect(await t.repository.fetchState()).toMatchObject({
      lastStatus: "failed",
      lastError: "models_dev_unreachable",
    });
  });

  // #548-T04
  it_(
    "keeps the previous rows when the body is larger than the cap",
    async () => {
      const t = await setup({ maxBytes: 256 * 1024 });
      await t.service.refresh();
      const before = await t.repository.listModels();
      t.advance(DAY);
      t.fake.respondWithOversize(3 * 1024 * 1024);

      const outcome = await t.service.refresh();

      expect(outcome).toEqual({
        status: "failed",
        code: "models_dev_too_large",
      });
      expect(await t.repository.listModels()).toEqual(before);
    },
  );

  // #548-T04
  it_(
    "does not apply a fetch that would unlist more than a tenth of the models, and says so",
    async () => {
      const t = await setup();
      await t.service.refresh();
      const before = await t.repository.listModels();
      t.advance(DAY);
      const poor = t.body();
      // 4 of the 13 listed models: 31 %.
      for (const id of ["grok-4.5"]) delete poor.xai?.models[id];
      for (const id of ["gpt-5.5", "gpt-5-mini"])
        delete poor.openai?.models[id];
      delete poor.google?.models["gemini-3.5-flash"];
      t.fake.respondWith(poor);

      const outcome = await t.service.refresh();

      expect(outcome).toEqual({
        status: "failed",
        code: "models_dev_guard_unlisted_share",
      });
      expect(await t.repository.listModels()).toEqual(before);
      expect(
        (await t.repository.listModels()).every((m) => m.unlistedAt === null),
      ).toBe(true);
      expect(await t.repository.fetchState()).toMatchObject({
        lastStatus: "failed",
        lastError: "models_dev_guard_unlisted_share",
      });
      expect(t.lines.join("\n")).toMatch(
        /models_dev_guard_unlisted_share.*reasons=unlisted_share unlisted=4 listed=13/,
      );
    },
  );

  // #548-T04
  it_(
    "does not apply a fetch that makes the catalog grow by more than half, and applies it when an admin accepts",
    async () => {
      const t = await setup();
      await t.service.refresh();
      const before = await t.repository.listModels();
      t.advance(DAY);
      const bloated = t.body();
      const template = bloated.deepseek?.models["deepseek-v4-pro"] ?? {};
      // 13 models listed, 8 more is 62 %.
      for (let i = 0; i < 8; i += 1)
        bloated.deepseek!.models[`filler-${String(i)}`] = {
          ...template,
          id: `filler-${String(i)}`,
          name: `Filler ${String(i)}`,
        };
      t.fake.respondWith(bloated);

      const refused = await t.service.refresh();

      expect(refused).toEqual({
        status: "failed",
        code: "models_dev_guard_growth",
      });
      expect(await t.repository.listModels()).toEqual(before);
      expect(await t.repository.fetchState()).toMatchObject({
        lastStatus: "failed",
        lastError: "models_dev_guard_growth",
      });
      expect(t.lines.join("\n")).not.toContain("Filler");

      const accepted = await t.service.refresh({ acceptLargeChange: true });

      expect(accepted).toMatchObject({ status: "applied" });
      expect(await t.repository.listModels()).toHaveLength(21);
    },
  );

  // #548-T04
  it_(
    "does not apply a fetch that blocks the address of many providers at once, and applies it when an admin accepts",
    async () => {
      const t = await setup();
      await t.service.refresh();
      const before = await t.repository.listProviders();
      t.advance(DAY);
      const moved = t.body();
      // 3 of 6 providers state another address.
      for (const id of ["deepseek", "openrouter", "xai"])
        moved[id]!.api = `https://api.${id}.moved.example/v1`;
      t.fake.respondWith(moved);

      const refused = await t.service.refresh();

      expect(refused).toEqual({
        status: "failed",
        code: "models_dev_guard_url_changed_share",
      });
      expect(await t.repository.listProviders()).toEqual(before);

      const accepted = await t.service.refresh({ acceptLargeChange: true });

      expect(accepted).toMatchObject({ status: "applied" });
      const states = (await t.repository.listProviders()).filter(
        (p) => p.url.state === "url_changed",
      );
      expect(states.map((p) => p.id).sort()).toEqual([
        "deepseek",
        "openrouter",
        "xai",
      ]);
      // Applied or not, an address that changed is never trusted by the fetch.
      expect(states.every((p) => !isUsable(p.url))).toBe(true);
    },
  );

  // #548-T04
  it_("applies the same fetch when an admin accepts the removal", async () => {
    const t = await setup();
    await t.service.refresh();
    t.advance(DAY);
    const poor = t.body();
    delete poor.xai?.models["grok-4.5"];
    delete poor.openai?.models["gpt-5.5"];
    delete poor.openai?.models["gpt-5-mini"];
    t.fake.respondWith(poor);

    const outcome = await t.service.refresh({ acceptLargeChange: true });

    expect(outcome).toMatchObject({ status: "applied" });
    expect(
      (await t.repository.listModels()).filter((m) => m.unlistedAt !== null),
    ).toHaveLength(3);
  });

  // #548-T08
  it_(
    "blocks a provider whose address changed, for every key, and unblocks it when the address is back",
    async () => {
      const t = await setup();
      await t.service.refresh();
      expect(isUsable((await t.repository.getProvider("deepseek"))!.url)).toBe(
        true,
      );

      t.advance(DAY);
      const moved = t.body();
      moved.deepseek!.api = "https://api.deepseek-proxy.example/v1";
      t.fake.respondWith(moved);
      await t.service.refresh();
      const blocked = await t.repository.getProvider("deepseek");
      expect(blocked?.url).toEqual({
        state: "url_changed",
        trustedUrl: "https://api.deepseek.com",
        pendingUrl: "https://api.deepseek-proxy.example/v1",
        problem: null,
      });
      expect(blocked?.urlChangedAt).toBe(
        new Date(T1.getTime() + DAY).toISOString(),
      );
      expect(isUsable(blocked!.url)).toBe(false);
      // The other providers are untouched.
      expect(
        isUsable((await t.repository.getProvider("openrouter"))!.url),
      ).toBe(true);

      t.advance(DAY);
      await t.service.refresh();
      expect((await t.repository.getProvider("deepseek"))?.urlChangedAt).toBe(
        blocked?.urlChangedAt,
      );

      t.advance(DAY);
      t.fake.respondWith(t.body());
      await t.service.refresh();
      expect(isUsable((await t.repository.getProvider("deepseek"))!.url)).toBe(
        true,
      );
    },
  );

  // #548-T07
  it_.each([
    [
      "an http address",
      "http://api.deepseek.com",
      async () => ["93.184.216.34"],
      "not_https",
    ],
    [
      "a private address",
      "https://10.0.0.5/v1",
      async () => ["93.184.216.34"],
      "private_address",
    ],
    [
      "the metadata address",
      "https://169.254.169.254/v1",
      async () => ["93.184.216.34"],
      "private_address",
    ],
    [
      "a name that resolves to loopback",
      "https://api.deepseek.com",
      // Only this name: a resolver that answers loopback for every name would block most providers at once, which the
      // guard refuses (a mass change of addresses).
      async (host: string) =>
        host === "api.deepseek.com" ? ["127.0.0.1"] : ["93.184.216.34"],
      "private_address",
    ],
  ] as const)(
    "never trusts %s on a first fetch",
    async (_name, api, resolveHost, problem) => {
      const t = await setup({ resolveHost });
      const body = t.body();
      body.deepseek!.api = api;
      t.fake.respondWith(body);

      await t.service.refresh();

      const provider = await t.repository.getProvider("deepseek");
      expect(provider?.url).toMatchObject({
        state: "rejected",
        trustedUrl: null,
        problem,
      });
      expect(isUsable(provider!.url)).toBe(false);
    },
  );

  // #548-T08
  it_(
    "blocks an address models.dev states for a provider the committed file has a default for, instead of trusting it on first sight",
    async () => {
      const t = await setup();
      const body = t.body();
      body.openai!.api = "https://evil.example/v1";
      t.fake.respondWith(body);

      await t.service.refresh();

      const provider = await t.repository.getProvider("openai");
      expect(provider?.url).toEqual({
        state: "url_changed",
        trustedUrl: "https://api.openai.com/v1",
        pendingUrl: "https://evil.example/v1",
        problem: null,
      });
      expect(isUsable(provider!.url)).toBe(false);
    },
  );

  // #548-T07
  it_(
    "blocks a trusted provider whose address turns into a poisoned one",
    async () => {
      const t = await setup();
      await t.service.refresh();
      t.advance(DAY);
      const poisoned = t.body();
      poisoned.deepseek!.api = "http://api.deepseek.com";
      t.fake.respondWith(poisoned);

      await t.service.refresh();

      expect((await t.repository.getProvider("deepseek"))?.url).toMatchObject({
        state: "url_changed",
        trustedUrl: "https://api.deepseek.com",
        problem: "not_https",
      });
    },
  );

  // #548-T13
  it_(
    "makes no call and writes nothing when the fetch is switched off",
    async () => {
      const t = await setup({ settings: { enabled: false } });

      const outcome = await t.service.refresh();

      expect(outcome).toEqual({ status: "skipped", reason: "fetch_off" });
      expect(t.fake.requests).toBe(0);
      expect(await t.repository.listProviders()).toEqual([]);
      expect(await t.repository.listModels()).toEqual([]);
      expect(await t.repository.fetchState()).toBeUndefined();
      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "fetch_off",
      });
      expect(t.fake.requests).toBe(0);
    },
  );

  // #548-T03
  it_(
    "fetches daily: when nothing was fetched, then not for 23 hours, then again, and an hour after a failure",
    async () => {
      const t = await setup();

      expect(await t.service.refreshIfDue()).toMatchObject({
        status: "applied",
      });
      expect(t.fake.requests).toBe(1);

      t.advance(22 * HOUR);
      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "not_due",
      });
      expect(t.fake.requests).toBe(1);

      t.advance(2 * HOUR);
      t.fake.respondWithStatus(503);
      expect(await t.service.refreshIfDue()).toEqual({
        status: "failed",
        code: "models_dev_http_status",
      });
      expect(t.fake.requests).toBe(2);

      t.advance(30 * 60 * 1000);
      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "not_due",
      });
      expect(t.fake.requests).toBe(2);

      t.advance(31 * 60 * 1000);
      t.fake.respondWith(t.body());
      expect(await t.service.refreshIfDue()).toMatchObject({
        status: "applied",
      });
      expect(t.fake.requests).toBe(3);
    },
  );

  // #548-T03
  it_(
    "lets one of two runs at the same time work and answers the other at once",
    async () => {
      const t = await setup();

      const outcomes = await Promise.all([
        t.service.refresh(),
        t.service.refresh(),
      ]);

      expect(outcomes.map((o) => o.status).sort()).toEqual([
        "applied",
        "skipped",
      ]);
      expect(t.fake.requests).toBe(1);
    },
  );

  // #548-T04
  it_(
    "records the attempt before the fetch starts, so that a run that is killed is not repeated at once",
    async () => {
      let seen: unknown;
      const t = await setup({
        fetchWith: (repository) => async (url, init) => {
          seen = await repository.fetchState();
          return fetch(url, init);
        },
      });

      await t.service.refresh();

      expect(seen).toMatchObject({
        lastAttemptAt: T1.toISOString(),
        lastSuccessAt: null,
      });
    },
  );

  // #548-T04
  it_(
    "waits an hour after an attempt that never ended before it tries again",
    async () => {
      const t = await setup();
      await t.service.refresh();
      t.advance(25 * HOUR);
      // A run that started and was killed by the platform: only its start is on record.
      await t.repository.recordAttempt(new Date(T1.getTime() + 25 * HOUR));

      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "not_due",
      });
      t.advance(30 * 60 * 1000);
      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "not_due",
      });
      t.advance(31 * 60 * 1000);
      expect(await t.service.refreshIfDue()).toMatchObject({
        status: "applied",
      });
    },
  );

  // #548-T04
  it_(
    "gives the lookups the time that is left after the fetch, minus what the write needs, and leaves the rest undecided",
    async () => {
      let tick = 0;
      const t = await setup({
        deadlineMs: 10_000,
        writeReserveMs: 2_000,
        lookupConcurrency: 1,
        clock: () => tick,
        resolveHost: async () => {
          tick += 3_000;
          return ["93.184.216.34"];
        },
      });

      const outcome = await t.service.refresh();

      // Three lookups end at 9 s; the 8 s the lookups may use are over, so the other three providers are not looked up.
      // Google and xai have an address in the committed file, so they are trusted all the same; openrouter has none.
      expect(outcome).toMatchObject({
        status: "applied",
        summary: { lookupsSkipped: 3, rejectedProviders: 1 },
      });
      const providers = await t.repository.listProviders();
      expect(providers.filter((p) => isUsable(p.url))).toHaveLength(5);
      expect(
        providers.filter((p) => p.url.problem === "unresolvable"),
      ).toHaveLength(1);
      expect((await t.repository.listModels()).length).toBe(13);
    },
  );

  // #548-T04
  it_(
    "fails a run that has no time left for the write, and leaves the rows as they were",
    async () => {
      let tick = 0;
      const t = await setup({
        deadlineMs: 10_000,
        writeReserveMs: 0,
        lookupConcurrency: 1,
        clock: () => tick,
        resolveHost: async () => {
          tick += 20_000;
          return ["93.184.216.34"];
        },
      });

      const outcome = await t.service.refresh();

      expect(outcome).toEqual({
        status: "failed",
        code: "models_dev_timeout",
      });
      expect(await t.repository.listModels()).toEqual([]);
      expect(await t.repository.fetchState()).toMatchObject({
        lastStatus: "failed",
        lastError: "models_dev_timeout",
      });
    },
  );

  // #548-T04
  it_(
    "does not let the fetch take more than the time that is left",
    async () => {
      const t = await setup({ deadlineMs: 300, writeReserveMs: 0 });
      t.fake.hang();
      const started = Date.now();

      const outcome = await t.service.refresh();

      expect(outcome).toEqual({
        status: "failed",
        code: "models_dev_unreachable",
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  // #548-T04
  it_(
    "retries a name that did not resolve on first sight at the next sweep, not after a day",
    async () => {
      let failing = true;
      const t = await setup({
        resolveHost: async () => {
          if (failing) throw new Error("EAI_AGAIN");
          return ["93.184.216.34"];
        },
      });

      const first = await t.service.refreshIfDue();

      expect(first).toMatchObject({
        status: "applied",
        // Four providers have an address in the committed file and are trusted at once; deepseek and openrouter wait.
        summary: { rejectedProviders: 2, retryProviders: 2 },
      });
      expect(
        (await t.repository.listProviders())
          .filter((p) => !isUsable(p.url))
          .every(
            (p) =>
              p.url.state === "rejected" && p.url.problem === "unresolvable",
          ),
      ).toBe(true);
      t.advance(30 * 60 * 1000);
      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "not_due",
      });

      failing = false;
      t.advance(31 * 60 * 1000);
      const second = await t.service.refreshIfDue();

      expect(second).toMatchObject({
        status: "applied",
        summary: { retryProviders: 0 },
      });
      expect(
        (await t.repository.listProviders()).every((p) => isUsable(p.url)),
      ).toBe(true);
      t.advance(2 * HOUR);
      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "not_due",
      });
    },
  );

  // #548-T04
  it_(
    "stops retrying a name that has not resolved for a day, and leaves it to the daily fetch",
    async () => {
      const t = await setup({
        resolveHost: async () => {
          throw new Error("ENOTFOUND");
        },
      });
      await t.service.refreshIfDue();

      t.advance(25 * HOUR);
      const later = await t.service.refreshIfDue();

      expect(later).toMatchObject({
        status: "applied",
        summary: { retryProviders: 0 },
      });
      t.advance(2 * HOUR);
      expect(await t.service.refreshIfDue()).toEqual({
        status: "skipped",
        reason: "not_due",
      });
    },
  );

  // #548-T08
  it_(
    "does not write over an admin's confirmation that is made while a fetch is planning",
    async () => {
      const t = await setup();
      await t.service.refresh();
      t.advance(DAY);
      const moved = t.body();
      moved.deepseek!.api = "https://api.deepseek.moved.example/v1";
      t.fake.respondWith(moved);
      await t.service.refresh();
      expect((await t.repository.getProvider("deepseek"))?.url.state).toBe(
        "url_changed",
      );

      // Another day: the same address, but the provider's name changed, so the fetch writes the row. An admin's
      // confirmation (#554: a guarded update of the one row) is in its transaction when the fetch reads the rows.
      t.advance(DAY);
      (moved.deepseek as { name?: string }).name = "DeepSeek AI";
      t.fake.respondWith(moved);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let updated!: () => void;
      const hasUpdated = new Promise<void>((resolve) => (updated = resolve));
      const confirmation = t.db.transaction().execute(async (trx) => {
        await trx
          .updateTable("models_dev_providers")
          .set({
            url_state: "trusted",
            trusted_url: "https://api.deepseek.moved.example/v1",
            pending_url: null,
            url_changed_at: null,
          })
          .where("provider_id", "=", "deepseek")
          .where("pending_url", "=", "https://api.deepseek.moved.example/v1")
          .execute();
        updated();
        await gate;
      });
      await hasUpdated;
      const fetch = t.service.refresh();
      // The fetch gets as far as reading the rows; with a lock it waits there, without one it plans on what it saw.
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
      await confirmation;
      const outcome = await fetch;

      expect(outcome).toMatchObject({ status: "applied" });
      const stored = await t.repository.getProvider("deepseek");
      expect(stored?.name).toBe("DeepSeek AI");
      expect(stored?.url).toMatchObject({
        state: "trusted",
        trustedUrl: "https://api.deepseek.moved.example/v1",
        pendingUrl: null,
      });
    },
  );

  // #548-T14
  it_(
    "logs counts only, never a name or an address the body held",
    async () => {
      const t = await setup();
      const body = t.body();
      body.deepseek!.models["deepseek-v4-pro"] = {
        ...body.deepseek!.models["deepseek-v4-pro"],
        name: "<script>SECRET-NAME</script>",
      };
      t.fake.respondWith(body);

      await t.service.refresh();

      const log = t.lines.join("\n");
      expect(log).not.toContain("SECRET-NAME");
      expect(log).not.toContain("api.deepseek.com");
    },
  );
});
