// SPDX-License-Identifier: LicenseRef-Proprietary

// The admin's side of the models.dev catalog (#554), over a real database: the providers with the state
// of their addresses, the confirmation of a changed address (a guarded update of the one row, never of a refused address,
// never of an address the admin did not see, never written over by the daily fetch and bounded in how long it waits for
// it), and "fetch now" with its deadline, its limit and the guard's override.
import { afterEach, describe, expect, it } from "vitest";
import {
  modelsDevFixture,
  startModelsDevFake,
  type ModelsDevFake,
} from "../../../fakes/models-dev/server.ts";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { MODELS_DEV_ENGINES } from "../test-support/models-dev-engines.ts";
import {
  FETCH_NOW_DEADLINE_MS,
  FETCH_NOW_KEY,
  FETCH_NOW_MAX,
  FETCH_NOW_WINDOW_MS,
  createModelsDevAdminService,
} from "./admin-service.ts";
import type { StoredModel, StoredProvider } from "./catalog.ts";
import { createModelsDevService } from "./service.ts";

const DAY = 24 * 60 * 60 * 1000;
const T1 = new Date("2026-10-19T03:00:00.000Z");
const PUBLIC = async () => ["93.184.216.34"];
const ACTOR = "admin-1";
const MOVED = "https://api.deepseek.moved.example/v1";

const fakes: ModelsDevFake[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

type Body = Record<
  string,
  { api?: string; name?: string; models: Record<string, unknown> }
>;

function provider(
  id: string,
  url: StoredProvider["url"],
  overrides: Partial<StoredProvider> = {},
): StoredProvider {
  return {
    id,
    name: id.toUpperCase(),
    url,
    urlChangedAt: url.state === "url_changed" ? T1.toISOString() : null,
    firstSeenAt: T1.toISOString(),
    unlistedAt: null,
    updatedAt: T1.toISOString(),
    ...overrides,
  };
}

function model(providerId: string, id: string): StoredModel {
  return {
    providerId,
    id,
    name: id,
    family: null,
    limit: { context: 1000, output: 100 },
    reasoning: false,
    temperature: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    status: null,
    cost: { input: "1", output: "2" },
    lastUpdated: null,
    interleaved: null,
    firstSeenAt: T1.toISOString(),
    unlistedAt: null,
    updatedAt: T1.toISOString(),
  };
}

describe.each(MODELS_DEV_ENGINES)(
  "the admin side of the models.dev catalog on $name",
  (engine) => {
    async function setup(
      options: { enabled?: boolean; lockTimeoutMs?: number } = {},
    ) {
      const fake = await startModelsDevFake();
      fakes.push(fake);
      const { db } = await engine.create();
      const repository = createModelsDevRepository(db);
      let now = T1;
      const lines: string[] = [];
      const models = createModelsDevService({
        db,
        repository,
        settings: () => ({
          enabled: options.enabled ?? true,
          url: fake.url,
          warnings: [],
        }),
        resolveHost: PUBLIC,
        now: () => now,
        log: {
          info: (line) => lines.push(line),
          error: (line) => lines.push(line),
        },
      });
      const calls: Array<Parameters<typeof models.refresh>[0]> = [];
      const admin = createModelsDevAdminService({
        db,
        models: {
          refresh: (refreshOptions) => {
            calls.push(refreshOptions);
            return models.refresh(refreshOptions);
          },
        },
        rateLimits: createRateLimitsRepository(db, () => now),
        settings: () => ({
          enabled: options.enabled ?? true,
          url: fake.url,
          warnings: [],
        }),
        ...(options.lockTimeoutMs === undefined
          ? {}
          : { lockTimeoutMs: options.lockTimeoutMs }),
        now: () => now,
        log: { info: (line) => lines.push(line) },
      });
      return {
        fake,
        db,
        repository,
        models,
        admin,
        calls,
        lines,
        advance: (ms: number) => {
          now = new Date(now.getTime() + ms);
        },
        body: () => modelsDevFixture() as Body,
      };
    }

    /** A catalog in which DeepSeek's address has changed and waits for an admin. */
    async function withChangedAddress() {
      const t = await setup();
      await t.repository.apply({
        providers: [
          provider("deepseek", {
            state: "url_changed",
            trustedUrl: "https://api.deepseek.com",
            pendingUrl: MOVED,
            problem: null,
          }),
          provider("openai", {
            state: "trusted",
            trustedUrl: "https://api.openai.com/v1",
            pendingUrl: null,
            problem: null,
          }),
        ],
        models: [
          model("deepseek", "deepseek-v4-pro"),
          model("openai", "gpt-5-mini"),
        ],
      });
      return t;
    }

    // #554-T06
    it("lists the providers with the state of their addresses and how many models each has", async () => {
      const t = await withChangedAddress();

      const list = await t.admin.providers();

      expect(list.fetchEnabled).toBe(true);
      expect(list.providers).toEqual([
        {
          id: "deepseek",
          name: "DEEPSEEK",
          listed: true,
          url: {
            state: "url_changed",
            trustedUrl: "https://api.deepseek.com",
            pendingUrl: MOVED,
            problem: null,
          },
          urlChangedAt: T1.toISOString(),
          models: 1,
        },
        {
          id: "openai",
          name: "OPENAI",
          listed: true,
          url: {
            state: "trusted",
            trustedUrl: "https://api.openai.com/v1",
            pendingUrl: null,
            problem: null,
          },
          urlChangedAt: null,
          models: 1,
        },
      ]);
    });

    // #554-T06
    it("confirms the address the admin saw: the new address is trusted and the provider is usable again", async () => {
      const t = await withChangedAddress();

      const result = await t.admin.confirmUrl(ACTOR, {
        providerId: "deepseek",
        pendingUrl: MOVED,
      });

      expect(result).toMatchObject({
        ok: true,
        provider: {
          id: "deepseek",
          url: {
            state: "trusted",
            trustedUrl: MOVED,
            pendingUrl: null,
            problem: null,
          },
          urlChangedAt: null,
        },
      });
      expect(
        t.lines.some((line) => line.includes("PROVIDER_URL_CONFIRMED")),
      ).toBe(true);
      const line = t.lines.find((l) => l.includes("PROVIDER_URL_CONFIRMED"));
      expect(line).toContain(`by=${ACTOR}`);
      expect(line).toContain('provider="deepseek"');
    });

    // #554-T06
    it("refuses to confirm an address other than the one the admin saw, and writes nothing", async () => {
      const t = await withChangedAddress();

      const result = await t.admin.confirmUrl(ACTOR, {
        providerId: "deepseek",
        pendingUrl: "https://api.somewhere-else.example/v1",
      });

      expect(result).toEqual({ ok: false, code: "url_changed_again" });
      expect((await t.repository.getProvider("deepseek"))?.url).toMatchObject({
        state: "url_changed",
        trustedUrl: "https://api.deepseek.com",
        pendingUrl: MOVED,
      });
    });

    // #548 review round: a refused address has no confirm
    it("never confirms a refused address, even when the admin sends the text it shows", async () => {
      const t = await setup();
      await t.repository.apply({
        providers: [
          provider("deepseek", {
            state: "url_changed",
            trustedUrl: "https://api.deepseek.com",
            pendingUrl: "http://169.254.169.254/latest",
            problem: "not_https",
          }),
          provider("xai", {
            state: "rejected",
            trustedUrl: null,
            pendingUrl: "https://xai.example:8443/v1",
            problem: "port_not_allowed",
          }),
        ],
        models: [],
      });

      const changed = await t.admin.confirmUrl(ACTOR, {
        providerId: "deepseek",
        pendingUrl: "http://169.254.169.254/latest",
      });
      const rejected = await t.admin.confirmUrl(ACTOR, {
        providerId: "xai",
        pendingUrl: "https://xai.example:8443/v1",
      });

      expect(changed).toEqual({ ok: false, code: "url_refused" });
      expect(rejected).toEqual({ ok: false, code: "url_refused" });
      expect((await t.repository.getProvider("deepseek"))?.url.state).toBe(
        "url_changed",
      );
      expect((await t.repository.getProvider("xai"))?.url).toMatchObject({
        state: "rejected",
        trustedUrl: null,
      });
    });

    // #554-T06
    it("refuses a provider whose address is not waiting for a decision, and an unknown one", async () => {
      const t = await withChangedAddress();

      const trusted = await t.admin.confirmUrl(ACTOR, {
        providerId: "openai",
        pendingUrl: "https://api.openai.com/v1",
      });
      const unknown = await t.admin.confirmUrl(ACTOR, {
        providerId: "nobody",
        pendingUrl: MOVED,
      });

      expect(trusted).toEqual({ ok: false, code: "url_not_pending" });
      expect(unknown).toEqual({ ok: false, code: "provider_unknown" });
    });

    // #554-T06
    it("accepts exactly a provider and an address", async () => {
      const t = await withChangedAddress();

      for (const input of [
        null,
        [],
        {},
        { providerId: "deepseek" },
        { providerId: "deepseek", pendingUrl: "" },
        { providerId: "deepseek", pendingUrl: 5 },
        { providerId: "deepseek", pendingUrl: MOVED, extra: true },
      ])
        expect(await t.admin.confirmUrl(ACTOR, input)).toEqual({
          ok: false,
          code: "request_invalid",
        });
    });

    // #548 review round: a confirmation racing a fetch is not lost
    it("keeps a confirmation that is made while the daily fetch runs, whichever of the two comes first", async () => {
      const t = await setup();
      await t.models.refresh();
      t.advance(DAY);
      const moved = t.body();
      moved.deepseek!.api = MOVED;
      t.fake.respondWith(moved);
      await t.models.refresh();
      expect((await t.repository.getProvider("deepseek"))?.url.state).toBe(
        "url_changed",
      );

      // The provider's name changes too, so that the fetch writes the row that is being confirmed.
      t.advance(DAY);
      moved.deepseek!.name = "DeepSeek AI";
      t.fake.respondWith(moved);
      const [confirmed, fetched] = await Promise.all([
        t.admin.confirmUrl(ACTOR, {
          providerId: "deepseek",
          pendingUrl: MOVED,
        }),
        t.models.refresh(),
      ]);

      expect(fetched).toMatchObject({ status: "applied" });
      expect(confirmed.ok).toBe(true);
      const stored = await t.repository.getProvider("deepseek");
      expect(stored?.name).toBe("DeepSeek AI");
      expect(stored?.url).toMatchObject({
        state: "trusted",
        trustedUrl: MOVED,
        pendingUrl: null,
      });
    });

    // #554-T08
    it("fetches now, with a deadline below the function limit, and says what was applied", async () => {
      const t = await setup();

      const result = await t.admin.fetchNow(ACTOR, {});

      expect(result).toMatchObject({
        ok: true,
        outcome: "applied",
        summary: { models: 13 },
      });
      expect(t.calls).toEqual([{ deadlineMs: FETCH_NOW_DEADLINE_MS }]);
      expect(
        t.lines.some(
          (line) => line.includes("FETCH_NOW") && line.includes(`by=${ACTOR}`),
        ),
      ).toBe(true);
    });

    // #554-T08
    it("answers a fetch that failed with its stable code", async () => {
      const t = await setup();
      t.fake.respondWithStatus(500);

      const result = await t.admin.fetchNow(ACTOR, {});

      expect(result).toEqual({ ok: false, code: "models_dev_http_status" });
    });

    // #554-T08
    it("says that the fetch is off for this instance, and makes no call", async () => {
      const t = await setup({ enabled: false });

      const result = await t.admin.fetchNow(ACTOR, {});

      expect(result).toEqual({ ok: false, code: "fetch_off" });
      expect(t.fake.requests).toBe(0);
      expect((await t.admin.providers()).fetchEnabled).toBe(false);
    });

    // #554-T08
    it("refuses a second fetch while one is running", async () => {
      const t = await setup();
      t.fake.hang();
      const first = t.models.refresh();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const second = await t.admin.fetchNow(ACTOR, {});

      expect(second).toEqual({ ok: false, code: "fetch_in_progress" });
      await t.fake.stop();
      await first;
    });

    // #554-T08
    it("gives the rate-limit token back for a fetch that was refused because another one is running", async () => {
      const t = await setup();
      t.fake.hang();
      const first = t.models.refresh();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // More tries than the limit allows, all while the daily fetch runs: none of them is a fetch.
      for (let i = 0; i < FETCH_NOW_MAX + 2; i += 1)
        expect(await t.admin.fetchNow(ACTOR, {})).toEqual({
          ok: false,
          code: "fetch_in_progress",
        });
      await t.fake.stop();
      await first;

      // Every token is back: the next try is the first of the window.
      const next = await createRateLimitsRepository(t.db).hit(
        FETCH_NOW_KEY,
        FETCH_NOW_WINDOW_MS,
      );
      expect(next.count).toBe(1);
    });

    // #554-T08
    it("limits how often an admin can fetch now", async () => {
      const t = await setup();
      for (let i = 0; i < FETCH_NOW_MAX; i += 1)
        expect(await t.admin.fetchNow(ACTOR, {})).toMatchObject({ ok: true });

      const result = await t.admin.fetchNow(ACTOR, {});

      expect(result).toMatchObject({ ok: false, code: "fetch_rate_limited" });
      expect(
        (result as { retryAfterSeconds?: number }).retryAfterSeconds,
      ).toBeGreaterThan(0);
      expect(t.fake.requests).toBe(FETCH_NOW_MAX);
    });

    /** Three models gone and ten new ones: two reasons trip at once. */
    function removalAndGrowth(t: Awaited<ReturnType<typeof setup>>) {
      const body = t.body();
      delete body.xai?.models["grok-4.5"];
      delete body.openai?.models["gpt-5.5"];
      delete body.openai?.models["gpt-5-mini"];
      const template = (body.deepseek!.models["deepseek-v4-pro"] ??
        {}) as Record<string, unknown>;
      for (let i = 0; i < 10; i += 1)
        body.deepseek!.models[`filler-${String(i)}`] = {
          ...template,
          id: `filler-${String(i)}`,
          name: `Filler ${String(i)}`,
        };
      t.fake.respondWith(body);
    }

    // #554-T08
    it("applies a fetch the guard refused only when the admin accepts the reasons that tripped", async () => {
      const t = await setup();
      await t.admin.fetchNow(ACTOR, {});
      t.advance(DAY);
      const bloated = t.body();
      const template = (bloated.deepseek!.models["deepseek-v4-pro"] ??
        {}) as Record<string, unknown>;
      // 13 models listed, 8 more is 62 %.
      for (let i = 0; i < 8; i += 1)
        bloated.deepseek!.models[`filler-${String(i)}`] = {
          ...template,
          id: `filler-${String(i)}`,
          name: `Filler ${String(i)}`,
        };
      t.fake.respondWith(bloated);

      const refused = await t.admin.fetchNow(ACTOR, {});
      const accepted = await t.admin.fetchNow(ACTOR, {
        acceptReasons: ["models_dev_guard_growth"],
      });

      expect(refused).toEqual({
        ok: false,
        code: "models_dev_guard_growth",
        guard: {
          reasons: ["models_dev_guard_growth"],
          details: expect.objectContaining({ listed: 13, listedAfter: 21 }),
        },
      });
      expect(accepted).toMatchObject({ ok: true, outcome: "applied" });
      expect(t.calls.at(-1)).toEqual({
        deadlineMs: FETCH_NOW_DEADLINE_MS,
        acceptReasons: ["growth"],
      });
      expect((await t.repository.listModels()).length).toBe(13 + 8);
      expect(
        t.lines.some((line) =>
          line.includes("accept_reasons=models_dev_guard_growth"),
        ),
      ).toBe(true);
    });

    // #554-T08
    it("answers every reason that tripped with the figures, and refuses again unless the second request names all of them", async () => {
      const t = await setup();
      await t.admin.fetchNow(ACTOR, {});
      const before = await t.repository.listModels();
      t.advance(DAY);
      removalAndGrowth(t);

      const refused = await t.admin.fetchNow(ACTOR, {});
      const partly = await t.admin.fetchNow(ACTOR, {
        acceptReasons: ["models_dev_guard_unlisted_share"],
      });

      const guard = {
        reasons: ["models_dev_guard_unlisted_share", "models_dev_guard_growth"],
        details: expect.objectContaining({
          unlisted: 3,
          listed: 13,
          listedAfter: 20,
        }),
      };
      expect(refused).toEqual({
        ok: false,
        code: "models_dev_guard_unlisted_share",
        guard,
      });
      expect(partly).toEqual({
        ok: false,
        code: "models_dev_guard_growth",
        guard,
      });
      expect(await t.repository.listModels()).toEqual(before);
      expect(
        await t.admin.fetchNow(ACTOR, {
          acceptReasons: [
            "models_dev_guard_growth",
            "models_dev_guard_unlisted_share",
          ],
        }),
      ).toMatchObject({ ok: true, outcome: "applied" });
    });

    // #554-T08
    it("accepts nothing but an optional list of the guard's codes called acceptReasons", async () => {
      const t = await setup();

      for (const input of [
        null,
        [],
        { acceptReasons: "models_dev_guard_growth" },
        { acceptReasons: [true] },
        { acceptReasons: ["growth"] },
        { acceptReasons: ["models_dev_timeout"] },
        {
          acceptReasons: ["models_dev_guard_growth", "models_dev_guard_growth"],
        },
        { acceptReasons: ["models_dev_guard_growth"], extra: 1 },
        // The boolean that accepted everything is gone.
        { acceptLargeChange: true },
        { other: true },
      ])
        expect(await t.admin.fetchNow(ACTOR, input)).toEqual({
          ok: false,
          code: "request_invalid",
        });
      expect(t.fake.requests).toBe(0);
    });
  },
);

// Postgres only: the wait for the lock the daily fetch holds is bounded.
describe.each(
  MODELS_DEV_ENGINES.filter((engine) => engine.name === "postgres"),
)("the confirmation of an address next to a long fetch on $name", (engine) => {
  // #554-T06
  it("gives up with fetch_in_progress when the fetch keeps its lock for too long, and writes nothing", async () => {
    const { db } = await engine.create();
    const repository = createModelsDevRepository(db);
    await repository.apply({
      providers: [
        provider("deepseek", {
          state: "url_changed",
          trustedUrl: "https://api.deepseek.com",
          pendingUrl: MOVED,
          problem: null,
        }),
      ],
      models: [],
    });
    const admin = createModelsDevAdminService({
      db,
      models: {
        refresh: async () => ({ status: "skipped", reason: "not_due" }),
      },
      rateLimits: createRateLimitsRepository(db),
      lockTimeoutMs: 200,
      log: { info: () => undefined },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLocked = new Promise<void>((resolve) => (locked = resolve));
    // What the fetch does while it writes: the provider rows, locked until its transaction ends.
    const fetch = db.transaction().execute(async (trx) => {
      await createModelsDevRepository(trx).listProviders({ forUpdate: true });
      locked();
      await gate;
    });
    await hasLocked;

    const result = await admin.confirmUrl(ACTOR, {
      providerId: "deepseek",
      pendingUrl: MOVED,
    });
    release();
    await fetch;

    expect(result).toEqual({ ok: false, code: "fetch_in_progress" });
    expect((await repository.getProvider("deepseek"))?.url).toMatchObject({
      state: "url_changed",
      pendingUrl: MOVED,
    });
  });
});
