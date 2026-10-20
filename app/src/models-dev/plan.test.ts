// SPDX-License-Identifier: Apache-2.0

// What one fetch writes (#548): new rows, changed rows, rows that disappear (unlisted, never deleted) and rows that
// return, the trust on first use of each provider's address, and the guard against a fetch that would unlist too much.
import { describe, expect, it } from "vitest";
import type { StoredModel, StoredProvider } from "./catalog.ts";
import type {
  ParsedModelsDev,
  ReducedModel,
  ReducedProvider,
} from "./parse.ts";
import {
  ENABLED_UNLISTED_MIN_COUNT,
  GROWTH_LIMIT,
  UNLISTED_SHARE_LIMIT,
  URL_CHANGED_SHARE_LIMIT,
  planCatalog,
} from "./plan.ts";
import type { UrlCheck } from "./upstream-url.ts";

const T1 = new Date("2026-10-19T03:00:00.000Z");
const T2 = new Date("2026-10-20T03:00:00.000Z");
const T3 = new Date("2026-10-21T03:00:00.000Z");
const URL_A = "https://api.deepseek.com";

function reducedProvider(id = "deepseek"): ReducedProvider {
  return { id, name: id, api: URL_A, apiTooLong: false };
}
function reducedModel(
  id: string,
  overrides: Partial<ReducedModel> = {},
  providerId = "deepseek",
): ReducedModel {
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
    ...overrides,
  };
}
function parsed(
  models: ReducedModel[],
  providers: ReducedProvider[] = [reducedProvider()],
): ParsedModelsDev {
  return {
    ok: true,
    providers,
    models,
    skipped: {
      invalid: 0,
      noToolCalling: 0,
      notLanguageModel: 0,
      modelProviderOverride: 0,
      unsupportedProviders: 0,
      unknownProviders: 0,
      oversizedProviders: 0,
    },
  };
}
const okUrl = (): ReadonlyMap<string, UrlCheck> =>
  new Map([["deepseek", { ok: true, url: URL_A }]]);

type Stored = { providers: StoredProvider[]; models: StoredModel[] };
/** What the repository would hold after applying a plan, to feed the next one. */
function applied(
  before: Stored,
  write: ReturnType<typeof planCatalog>["write"],
): Stored {
  const providers = new Map(before.providers.map((p) => [p.id, p]));
  for (const p of write.providers) providers.set(p.id, p);
  const models = new Map(
    before.models.map((m) => [`${m.providerId}/${m.id}`, m]),
  );
  for (const m of write.models) models.set(`${m.providerId}/${m.id}`, m);
  return { providers: [...providers.values()], models: [...models.values()] };
}
const EMPTY: Stored = { providers: [], models: [] };
const ids = (models: StoredModel[]) => models.map((m) => m.id).sort();

describe("planning what a fetch writes", () => {
  // #548-T03
  it("writes every provider and model of a first fetch, seen now", () => {
    const plan = planCatalog({
      parsed: parsed([reducedModel("a"), reducedModel("b")]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });

    expect(ids(plan.write.models)).toEqual(["a", "b"]);
    expect(
      plan.write.models.every(
        (m) => m.firstSeenAt === T1.toISOString() && m.unlistedAt === null,
      ),
    ).toBe(true);
    expect(plan.write.providers).toEqual([
      expect.objectContaining({
        id: "deepseek",
        firstSeenAt: T1.toISOString(),
        url: {
          state: "trusted",
          trustedUrl: URL_A,
          pendingUrl: null,
          problem: null,
        },
      }),
    ]);
    expect(plan.summary).toMatchObject({
      providers: 1,
      models: 2,
      newModels: 2,
      changedModels: 0,
      unlistedModels: 0,
      returnedModels: 0,
    });
  });

  // #548-T03
  it("writes nothing when nothing changed", () => {
    const first = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    const stored = applied(EMPTY, first.write);

    const second = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored,
      urlChecks: okUrl(),
      now: T2,
    });

    expect(second.write).toEqual({ providers: [], models: [] });
    expect(second.summary).toMatchObject({ newModels: 0, changedModels: 0 });
  });

  // #548-T03
  it("updates a model whose price changed, and keeps the day it was first seen", () => {
    const first = planCatalog({
      parsed: parsed([reducedModel("a"), reducedModel("b")]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    const stored = applied(EMPTY, first.write);

    const second = planCatalog({
      parsed: parsed([
        reducedModel("a", { cost: { input: "1", output: "3" } }),
        reducedModel("b"),
      ]),
      stored,
      urlChecks: okUrl(),
      now: T2,
    });

    expect(second.write.models).toEqual([
      expect.objectContaining({
        id: "a",
        cost: { input: "1", output: "3" },
        firstSeenAt: T1.toISOString(),
        updatedAt: T2.toISOString(),
      }),
    ]);
    expect(second.summary).toMatchObject({ changedModels: 1, newModels: 0 });
  });

  // #548-T03
  it("marks a model that vanished as unlisted with the date, keeps its last known entry, and clears it when it returns", () => {
    const models = [
      reducedModel("a"),
      ...Array.from({ length: 19 }, (_unused, i) =>
        reducedModel(`m${String(i)}`),
      ),
    ];
    const first = planCatalog({
      parsed: parsed(models),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    const stored1 = applied(EMPTY, first.write);

    const vanished = planCatalog({
      parsed: parsed(models.slice(1)),
      stored: stored1,
      urlChecks: okUrl(),
      now: T2,
    });
    expect(vanished.write.models).toEqual([
      expect.objectContaining({
        id: "a",
        unlistedAt: T2.toISOString(),
        cost: { input: "1", output: "2" },
        limit: { context: 1000, output: 100 },
      }),
    ]);
    expect(vanished.summary).toMatchObject({ unlistedModels: 1 });
    const stored2 = applied(stored1, vanished.write);

    const stillGone = planCatalog({
      parsed: parsed(models.slice(1)),
      stored: stored2,
      urlChecks: okUrl(),
      now: T3,
    });
    expect(stillGone.write.models).toEqual([]);

    const returned = planCatalog({
      parsed: parsed(models),
      stored: stored2,
      urlChecks: okUrl(),
      now: T3,
    });
    expect(returned.write.models).toEqual([
      expect.objectContaining({
        id: "a",
        unlistedAt: null,
        firstSeenAt: T1.toISOString(),
        updatedAt: T3.toISOString(),
      }),
    ]);
    expect(returned.summary).toMatchObject({ returnedModels: 1 });
  });

  // #548-T03
  it("unlists the models of a provider that is gone, and the provider", () => {
    const first = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    const stored = applied(EMPTY, first.write);
    const other = parsed(
      [reducedModel("x", {}, "openai")],
      [reducedProvider("openai")],
    );

    const plan = planCatalog({
      parsed: other,
      stored,
      urlChecks: new Map([
        ["openai", { ok: true, url: "https://api.openai.com/v1" }],
      ]),
      now: T2,
    });

    expect(
      plan.write.providers.find((p) => p.id === "deepseek")?.unlistedAt,
    ).toBe(T2.toISOString());
    expect(plan.write.models.find((m) => m.id === "a")?.unlistedAt).toBe(
      T2.toISOString(),
    );
    expect(
      plan.write.providers.find((p) => p.id === "openai")?.unlistedAt,
    ).toBeNull();
  });

  // #548-T03
  it("keeps a deprecated status as the status of the model, and the model", () => {
    const plan = planCatalog({
      parsed: parsed([reducedModel("old", { status: "deprecated" })]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });

    expect(plan.write.models[0]).toMatchObject({
      id: "old",
      status: "deprecated",
      unlistedAt: null,
    });
  });
});

describe("the fetch guard", () => {
  const twenty = Array.from({ length: 20 }, (_unused, i) =>
    reducedModel(`m${String(i)}`),
  );
  const stored = applied(
    EMPTY,
    planCatalog({
      parsed: parsed(twenty),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    }).write,
  );

  // #548-T04
  it("allows a fetch that unlists up to a tenth of the listed models", () => {
    expect(UNLISTED_SHARE_LIMIT).toBe(0.1);

    const plan = planCatalog({
      parsed: parsed(twenty.slice(2)),
      stored,
      urlChecks: okUrl(),
      now: T2,
    });

    expect(plan.guard).toEqual({
      tripped: false,
      reasons: [],
      unlisted: 2,
      listed: 20,
    });
  });

  // #548-T04
  it("trips on a fetch that would unlist more than a tenth", () => {
    const plan = planCatalog({
      parsed: parsed(twenty.slice(3)),
      stored,
      urlChecks: okUrl(),
      now: T2,
    });

    expect(plan.guard).toEqual({
      tripped: true,
      reasons: ["unlisted_share"],
      unlisted: 3,
      listed: 20,
    });
  });

  // #548-T04
  it("trips on a fetch that would unlist a tenth of the providers", () => {
    const providers = Array.from({ length: 10 }, (_unused, i) =>
      reducedProvider(`p${String(i)}`),
    );
    const models = providers.map((p) => reducedModel("m", {}, p.id));
    const checks = new Map(
      providers.map((p) => [p.id, { ok: true, url: URL_A } as UrlCheck]),
    );
    const big = applied(
      EMPTY,
      planCatalog({
        parsed: parsed(models, providers),
        stored: EMPTY,
        urlChecks: checks,
        now: T1,
      }).write,
    );

    const plan = planCatalog({
      parsed: parsed(models.slice(2), providers.slice(2)),
      stored: big,
      urlChecks: checks,
      now: T2,
    });

    expect(plan.guard.tripped).toBe(true);
    expect(plan.guard.reasons).toContain("unlisted_share");
  });

  // #548-T04
  it("does not count a model that was already unlisted, and never trips on a first fetch", () => {
    const first = planCatalog({
      parsed: parsed(twenty),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    expect(first.guard).toEqual({
      tripped: false,
      reasons: [],
      unlisted: 0,
      listed: 0,
    });

    const gone = applied(
      stored,
      planCatalog({
        parsed: parsed(twenty.slice(2)),
        stored,
        urlChecks: okUrl(),
        now: T2,
      }).write,
    );
    const again = planCatalog({
      parsed: parsed(twenty.slice(2)),
      stored: gone,
      urlChecks: okUrl(),
      now: T3,
    });
    expect(again.guard).toEqual({
      tripped: false,
      reasons: [],
      unlisted: 0,
      listed: 18,
    });
  });
});

describe("the fetch guard and the models an admin enabled", () => {
  const hundred = Array.from({ length: 100 }, (_unused, i) =>
    reducedModel(`m${String(i)}`),
  );
  const stored = applied(
    EMPTY,
    planCatalog({
      parsed: parsed(hundred),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    }).write,
  );
  const enabledOf = (from: number, to: number) =>
    hundred
      .slice(from, to)
      .map((model) => ({ providerId: "deepseek", modelId: model.id }));
  /** The fetch of the next day without the models at these positions. */
  const without = (positions: number[]) =>
    parsed(hundred.filter((_model, index) => !positions.includes(index)));
  const plan = (positions: number[], enabled?: ReturnType<typeof enabledOf>) =>
    planCatalog({
      parsed: without(positions),
      stored,
      urlChecks: okUrl(),
      now: T2,
      ...(enabled === undefined ? {} : { enabled }),
    });

  // #549-T13
  it("trips when the enabled models are the ones that vanish, even if they are a few of all", () => {
    expect(ENABLED_UNLISTED_MIN_COUNT).toBe(3);

    const result = plan([0, 1, 2], enabledOf(0, 10));

    expect(result.guard).toEqual({
      tripped: true,
      reasons: ["enabled_unlisted_share"],
      unlisted: 3,
      listed: 100,
    });
  });

  // #549-T13
  it("does not trip when the same fetch is not about enabled models", () => {
    expect(plan([50, 51, 52], enabledOf(0, 10)).guard.tripped).toBe(false);
  });

  // #549-T13
  it("does not trip on a model or two of the enabled ones, which is the normal case of a provider retiring a model", () => {
    expect(plan([0, 1], enabledOf(0, 10)).guard.tripped).toBe(false);
  });

  // #549-T13
  it("does not trip when the enabled ones that vanish are at most a tenth of them", () => {
    expect(plan([0, 1, 2], enabledOf(0, 40)).guard.tripped).toBe(false);
    expect(plan([0, 1, 2, 3, 4], enabledOf(0, 40)).guard.tripped).toBe(true);
  });

  // #549-T13
  it("is the guard of before when nobody enabled a model", () => {
    expect(plan([0, 1, 2]).guard.tripped).toBe(false);
    expect(plan([0, 1, 2], []).guard.tripped).toBe(false);
  });

  // #549-T13
  it("does not count a model that was unlisted already, or an enabled model that is not in the catalog", () => {
    const gone = applied(
      stored,
      planCatalog({
        parsed: without([0, 1, 2]),
        stored,
        urlChecks: okUrl(),
        now: T2,
      }).write,
    );

    const result = planCatalog({
      parsed: without([0, 1, 2]),
      stored: gone,
      urlChecks: okUrl(),
      now: T3,
      enabled: [
        ...enabledOf(0, 10),
        { providerId: "deepseek", modelId: "never-listed" },
      ],
    });

    expect(result.guard.tripped).toBe(false);
  });
});

describe("the growth guard", () => {
  const models = (count: number, from = 0) =>
    Array.from({ length: count }, (_unused, i) =>
      reducedModel(`m${String(from + i)}`),
    );
  const fill = (count: number) =>
    applied(
      EMPTY,
      planCatalog({
        parsed: parsed(models(count)),
        stored: EMPTY,
        urlChecks: okUrl(),
        now: T1,
      }).write,
    );
  const fetchOf = (stored: Stored, body: ReducedModel[]) =>
    planCatalog({
      parsed: parsed(body),
      stored,
      urlChecks: okUrl(),
      now: T2,
    });

  // #548-T04
  it("allows a catalog to grow by half and trips on more", () => {
    expect(GROWTH_LIMIT).toBe(0.5);
    const stored = fill(20);

    expect(fetchOf(stored, models(30)).guard).toMatchObject({
      tripped: false,
      reasons: [],
    });
    expect(fetchOf(stored, models(31)).guard).toMatchObject({
      tripped: true,
      reasons: ["growth"],
    });
  });

  // #548-T04
  it("counts the net growth: models that vanish in the same fetch make room for new ones", () => {
    const stored = fill(20);

    // 2 unlisted (a tenth, allowed), 31 + ... new: 18 kept + 12 new = 30 listed, 50 %.
    const plan = fetchOf(stored, [...models(18, 2), ...models(12, 100)]);

    expect(plan.guard).toMatchObject({ tripped: false, unlisted: 2 });
  });

  // #548-T04
  it("counts a model that returns as growth", () => {
    const stored = fill(20);
    const gone = applied(stored, fetchOf(stored, models(18, 2)).write);

    // 18 listed before; all 20 back plus 10 new: 30 listed, 67 %.
    const plan = planCatalog({
      parsed: parsed([...models(20), ...models(10, 100)]),
      stored: gone,
      urlChecks: okUrl(),
      now: T3,
    });

    expect(plan.guard.reasons).toEqual(["growth"]);
  });

  // #548-T04
  it("never trips on the first fetch into an empty database, however large", () => {
    const plan = fetchOf(EMPTY, models(500));

    expect(plan.guard).toMatchObject({ tripped: false, reasons: [] });
  });

  // #548-T04
  it("trips when the database holds rows and none of them is listed any more", () => {
    const stored = fill(5);
    const allGone = applied(
      stored,
      planCatalog({
        parsed: parsed([reducedModel("x")]),
        stored,
        urlChecks: okUrl(),
        now: T2,
      }).write,
    );
    const lonely = {
      ...allGone,
      models: allGone.models.map((m) =>
        m.id === "x" ? { ...m, unlistedAt: T2.toISOString() } : m,
      ),
    };

    const plan = planCatalog({
      parsed: parsed(models(40)),
      stored: lonely,
      urlChecks: okUrl(),
      now: T3,
    });

    expect(plan.guard.reasons).toContain("growth");
  });

  // #548-T04
  it("trips on a provider that was too large to read, whatever else the fetch did", () => {
    const stored = fill(20);
    const body = parsed(models(20));
    body.skipped.oversizedProviders = 1;

    const plan = planCatalog({
      parsed: body,
      stored,
      urlChecks: okUrl(),
      now: T2,
    });

    expect(plan.guard).toMatchObject({
      tripped: true,
      reasons: ["provider_size"],
    });
    expect(plan.summary.oversizedProviders).toBe(1);
  });
});

describe("the guard against a mass change of addresses", () => {
  const providers = (count: number) =>
    Array.from({ length: count }, (_unused, i) =>
      reducedProvider(`p${String(i)}`),
    );
  const checks = (list: ReducedProvider[], url: (id: string) => string) =>
    new Map(list.map((p) => [p.id, { ok: true, url: url(p.id) } as UrlCheck]));
  const modelsOf = (list: ReducedProvider[]) =>
    list.map((p) => reducedModel("m", {}, p.id));
  const fill = (list: ReducedProvider[]) =>
    applied(
      EMPTY,
      planCatalog({
        parsed: parsed(modelsOf(list), list),
        stored: EMPTY,
        urlChecks: checks(list, (id) => `https://${id}.example/v1`),
        now: T1,
      }).write,
    );
  /** The next day: the addresses of the first `moved` providers are different. */
  const nextDay = (list: ReducedProvider[], stored: Stored, moved: number) =>
    planCatalog({
      parsed: parsed(modelsOf(list), list),
      stored,
      urlChecks: checks(list, (id) =>
        list.findIndex((p) => p.id === id) < moved
          ? `https://${id}.moved.example/v1`
          : `https://${id}.example/v1`,
      ),
      now: T2,
    });

  // #548-T04
  it("allows a tenth of the providers to change their address and trips on more", () => {
    expect(URL_CHANGED_SHARE_LIMIT).toBe(0.1);
    const list = providers(30);
    const stored = fill(list);

    const three = nextDay(list, stored, 3);
    expect(three.guard).toMatchObject({ tripped: false, reasons: [] });
    expect(three.summary.blockedProviders).toBe(3);

    const four = nextDay(list, stored, 4);
    expect(four.guard).toMatchObject({
      tripped: true,
      reasons: ["url_changed_share"],
    });
  });

  // #548-T08
  it("always lets one or two providers change, however few there are", () => {
    const list = providers(6);
    const stored = fill(list);

    expect(nextDay(list, stored, 1).guard.tripped).toBe(false);
    expect(nextDay(list, stored, 2).guard.tripped).toBe(false);
    expect(nextDay(list, stored, 3).guard.reasons).toEqual([
      "url_changed_share",
    ]);
  });

  // #548-T08
  it("does not count a provider that was blocked already", () => {
    const list = providers(30);
    const stored = fill(list);
    const first = nextDay(list, stored, 3);
    const blocked = applied(stored, first.write);

    const again = nextDay(list, blocked, 3);

    expect(again.guard).toMatchObject({ tripped: false, reasons: [] });
  });
});

describe("the address of a provider across fetches", () => {
  // #548-T08
  it("blocks the provider when the address changes, and keeps the trusted one", () => {
    const first = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    const stored = applied(EMPTY, first.write);

    const second = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored,
      urlChecks: new Map([
        ["deepseek", { ok: true, url: "https://elsewhere.example/v1" }],
      ]),
      now: T2,
    });

    expect(second.write.providers).toEqual([
      expect.objectContaining({
        url: {
          state: "url_changed",
          trustedUrl: URL_A,
          pendingUrl: "https://elsewhere.example/v1",
          problem: null,
        },
        urlChangedAt: T2.toISOString(),
      }),
    ]);
    expect(second.summary).toMatchObject({ blockedProviders: 1 });
    // The models are stored as before: the block is on the provider, not on its rows.
    expect(second.write.models).toEqual([]);
  });

  // #548-T08
  it("dates the block from its first day, not from the day it was seen again", () => {
    const first = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    const changedChecks = new Map<string, UrlCheck>([
      ["deepseek", { ok: true, url: "https://elsewhere.example/v1" }],
    ]);
    const second = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: applied(EMPTY, first.write),
      urlChecks: changedChecks,
      now: T2,
    });
    const stored = applied(applied(EMPTY, first.write), second.write);

    const third = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored,
      urlChecks: changedChecks,
      now: T3,
    });

    expect(third.write.providers).toEqual([]);
    expect(stored.providers[0]?.urlChangedAt).toBe(T2.toISOString());
  });

  // #548-T07
  it("does not trust an address that is refused on its first sight, and still lists the models for the admin", () => {
    const plan = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: new Map([
        [
          "deepseek",
          { ok: false, problem: "not_https", seen: "http://api.deepseek.com" },
        ],
      ]),
      now: T1,
    });

    expect(plan.write.providers[0]?.url).toEqual({
      state: "rejected",
      trustedUrl: null,
      pendingUrl: "http://api.deepseek.com",
      problem: "not_https",
    });
    expect(plan.summary).toMatchObject({ rejectedProviders: 1 });
  });

  // #548-T07
  it("asks for another try soon when the name of a new provider did not resolve, and for a limited time", () => {
    const unresolvable = new Map<string, UrlCheck>([
      ["deepseek", { ok: false, problem: "unresolvable", seen: URL_A }],
    ]);
    const first = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: unresolvable,
      now: T1,
    });
    expect(first.summary).toMatchObject({
      rejectedProviders: 1,
      retryProviders: 1,
    });

    const stored = applied(EMPTY, first.write);
    const nextDay = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored,
      urlChecks: unresolvable,
      now: new Date(T1.getTime() + 25 * 60 * 60 * 1000),
    });
    expect(nextDay.summary).toMatchObject({
      rejectedProviders: 1,
      retryProviders: 0,
    });
  });

  // #548-T07
  it("does not ask for a retry for an address that is bad, or for a trusted one that did not resolve today", () => {
    const refused = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: new Map<string, UrlCheck>([
        ["deepseek", { ok: false, problem: "not_https", seen: "http://x" }],
      ]),
      now: T1,
    });
    expect(refused.summary.retryProviders).toBe(0);

    const trusted = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: okUrl(),
      now: T1,
    });
    const later = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: applied(EMPTY, trusted.write),
      urlChecks: new Map<string, UrlCheck>([
        ["deepseek", { ok: false, problem: "unresolvable", seen: URL_A }],
      ]),
      now: T2,
    });
    expect(later.summary.retryProviders).toBe(0);
  });
});

describe("the address the committed provider file states seeds trust", () => {
  // openai: the file records https://api.openai.com/v1 as the default of its SDK.
  const SEED = "https://api.openai.com/v1";
  const openai = (api: string | null): ReducedProvider => ({
    id: "openai",
    name: "OpenAI",
    api,
    apiTooLong: false,
  });
  const plan = (check: UrlCheck, stored: Stored = EMPTY, now = T1) =>
    planCatalog({
      parsed: parsed(
        [reducedModel("gpt", {}, "openai")],
        [openai("https://elsewhere.example/v1")],
      ),
      stored,
      urlChecks: new Map([["openai", check]]),
      now,
    });

  // #548-T08
  it("blocks a different address on first sight instead of trusting it", () => {
    const first = plan({ ok: true, url: "https://elsewhere.example/v1" });

    expect(first.write.providers[0]?.url).toEqual({
      state: "url_changed",
      trustedUrl: SEED,
      pendingUrl: "https://elsewhere.example/v1",
      problem: null,
    });
    expect(first.summary).toMatchObject({ blockedProviders: 1 });
  });

  // #548-T08
  it("trusts the address when models.dev states the same one", () => {
    const first = plan({ ok: true, url: SEED });

    expect(first.write.providers[0]?.url).toEqual({
      state: "trusted",
      trustedUrl: SEED,
      pendingUrl: null,
      problem: null,
    });
  });

  // #548-T07
  it("blocks an address that is refused on first sight, and keeps the seed as the trusted one", () => {
    const first = plan({
      ok: false,
      problem: "not_https",
      seen: "http://api.openai.com/v1",
    });

    expect(first.write.providers[0]?.url).toEqual({
      state: "url_changed",
      trustedUrl: SEED,
      pendingUrl: "http://api.openai.com/v1",
      problem: "not_https",
    });
  });

  // #548-T07
  it("does not reject a provider whose name did not resolve: the seed is trusted already", () => {
    const first = plan({ ok: false, problem: "unresolvable", seen: SEED });

    expect(first.write.providers[0]?.url).toMatchObject({
      state: "trusted",
      trustedUrl: SEED,
    });
    expect(first.summary).toMatchObject({
      rejectedProviders: 0,
      retryProviders: 0,
    });
  });

  // #548-T08
  it("seeds a provider that was rejected before it had a seed, and leaves a stored trusted address alone", () => {
    const rejected = plan({ ok: false, problem: "private_address", seen: "x" });
    const stored = applied(EMPTY, rejected.write);
    const again = plan({ ok: true, url: SEED }, stored, T2);
    expect(again.write.providers[0]?.url).toMatchObject({
      state: "trusted",
      trustedUrl: SEED,
    });

    // A trusted address that is not the seed (stored by an earlier release) is what stays trusted.
    const earlier: Stored = {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          url: {
            state: "trusted",
            trustedUrl: "https://gateway.example/v1",
            pendingUrl: null,
            problem: null,
          },
          urlChangedAt: null,
          firstSeenAt: T1.toISOString(),
          unlistedAt: null,
          updatedAt: T1.toISOString(),
        },
      ],
      models: [],
    };
    const next = plan({ ok: true, url: SEED }, earlier, T2);
    expect(next.write.providers[0]?.url).toMatchObject({
      state: "url_changed",
      trustedUrl: "https://gateway.example/v1",
      pendingUrl: SEED,
    });
  });

  // #548-T08
  it("still trusts the first address of a provider the file gives no default for", () => {
    const first = planCatalog({
      parsed: parsed([reducedModel("a")]),
      stored: EMPTY,
      urlChecks: new Map([["deepseek", { ok: true, url: URL_A }]]),
      now: T1,
    });

    expect(first.write.providers[0]?.url).toMatchObject({
      state: "trusted",
      trustedUrl: URL_A,
    });
  });
});
