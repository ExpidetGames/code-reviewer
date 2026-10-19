// SPDX-License-Identifier: Apache-2.0

// The entry a job is told about its model (#548, part E): built from one stored provider and one stored model, checked
// against `contracts/job-model-entry.v1.json`, secret free, and refused for a provider or model that must not reach a job.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContractValidator } from "../test-support/runner-contract.ts";
import type { StoredModel, StoredProvider } from "./catalog.ts";
import {
  JOB_ENTRY_REFUSAL_CODES,
  buildJobModelEntry,
  jobModelEntrySchema,
} from "./job-entry.ts";
import { parseModelsDev } from "./parse.ts";
import { planCatalog } from "./plan.ts";
import type { UrlCheck } from "./upstream-url.ts";
import { BUNDLED_NPM, INTERLEAVED_FIELDS } from "./wire.ts";

const contract = createContractValidator("job-model-entry.v1.json");
const NOW = new Date("2026-10-19T03:00:00.000Z");

const body = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fakes",
      "fixtures",
      "models-dev",
      "api.json",
    ),
    "utf8",
  ),
) as unknown;

/** The rows a first fetch of the fixture stores, with the address check given. */
function stored(
  check: (id: string) => UrlCheck = (id) => ({
    ok: true,
    url: `https://api.${id}.example/v1`,
  }),
) {
  const parsed = parseModelsDev(body);
  if (!parsed.ok) throw new Error("fixture");
  const plan = planCatalog({
    parsed,
    stored: { providers: [], models: [] },
    urlChecks: new Map(parsed.providers.map((p) => [p.id, check(p.id)])),
    now: NOW,
  });
  const provider = (id: string) =>
    plan.write.providers.find((p) => p.id === id) as StoredProvider;
  const model = (providerId: string, id: string) =>
    plan.write.models.find(
      (m) => m.providerId === providerId && m.id === id,
    ) as StoredModel;
  return { provider, model };
}

function build(
  providerId: string,
  modelId: string,
  check?: (id: string) => UrlCheck,
  tweak?: (m: StoredModel) => StoredModel,
) {
  const rows = stored(check);
  const model =
    tweak === undefined
      ? rows.model(providerId, modelId)
      : tweak(rows.model(providerId, modelId));
  return buildJobModelEntry(rows.provider(providerId), model);
}

function entryOf(result: ReturnType<typeof build>) {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.entry;
}

describe("building the entry of a job", () => {
  // #548-T10
  it.each([
    ["deepseek", "deepseek-v4-pro"],
    ["anthropic", "claude-haiku-5-5"],
    ["openai", "gpt-5.5"],
    ["google", "gemini-3.5-flash"],
    ["xai", "grok-4.5"],
    ["openrouter", "mistralai/mistral-saba"],
  ])("validates against the contract for %s %s", (providerId, modelId) => {
    const entry = entryOf(build(providerId, modelId));

    const { valid, errors } = contract.check("JobModelEntry", entry);

    expect({ valid, errors }).toEqual({ valid: true, errors: "" });
  });

  // #548-T10
  it("names the SDK, the wire family, the key header and the trusted upstream address of the provider", () => {
    expect(entryOf(build("deepseek", "deepseek-v4-pro"))).toMatchObject({
      version: 1,
      providerId: "deepseek",
      npm: "@ai-sdk/openai-compatible",
      family: "openai-chat",
      authHeader: "Authorization",
      upstreamBaseUrl: "https://api.deepseek.example/v1",
      modelId: "deepseek-v4-pro",
    });
    expect(entryOf(build("anthropic", "claude-haiku-5-5"))).toMatchObject({
      npm: "@ai-sdk/anthropic",
      family: "anthropic-messages",
      authHeader: "x-api-key",
    });
    expect(entryOf(build("openai", "gpt-5.5"))).toMatchObject({
      family: "openai-responses",
    });
    expect(entryOf(build("google", "gemini-3.5-flash"))).toMatchObject({
      family: "google",
      authHeader: "x-goog-api-key",
    });
  });

  // #548-T10
  it("copies the limits and the flags exactly, and the name of the selected model only", () => {
    const rows = stored();
    const model = rows.model("deepseek", "deepseek-v4-pro");

    const entry = entryOf(buildJobModelEntry(rows.provider("deepseek"), model));

    expect(entry.model).toEqual({
      name: model.name,
      status: "active",
      tool_call: true,
      reasoning: model.reasoning,
      temperature: model.temperature,
      limit: { context: model.limit.context, output: model.limit.output },
      modalities: model.modalities,
      interleaved: { field: "reasoning_content" },
    });
  });

  // #548-T10
  it("keeps both limits or the optional input limit, never one of the two", () => {
    const withInput = entryOf(
      build("deepseek", "deepseek-v4-pro", undefined, (m) => ({
        ...m,
        limit: { context: 1000, output: 100, input: 900 },
      })),
    );

    expect(withInput.model.limit).toEqual({
      context: 1000,
      output: 100,
      input: 900,
    });
  });

  // #548-T10
  it("contains only the selected model, no key and no other field of the catalog", () => {
    const entry = entryOf(build("deepseek", "deepseek-v4-pro"));
    const text = JSON.stringify(entry).toLowerCase();

    expect(Object.keys(entry).sort()).toEqual([
      "authHeader",
      "family",
      "model",
      "modelId",
      "npm",
      "providerId",
      "upstreamBaseUrl",
      "version",
    ]);
    for (const secret of [
      "apikey",
      "api_key",
      "secret",
      "token",
      "bearer",
      "password",
      "authorization:",
    ])
      expect(text).not.toContain(secret);
    expect(text).not.toContain("deepseek-flash");
    expect(text).not.toContain("cost");
    expect(text).not.toContain("price");
    expect(entry.model).not.toHaveProperty("cost");
  });

  // #548-T10
  it("writes a status the pinned engine does not drop: deprecated and alpha run as active, beta as beta", () => {
    const deprecated = entryOf(build("deepseek", "deepseek-v4-flash"));
    const alpha = entryOf(
      build("deepseek", "deepseek-v4-pro", undefined, (m) => ({
        ...m,
        status: "alpha",
      })),
    );
    const beta = entryOf(
      build("deepseek", "deepseek-v4-pro", undefined, (m) => ({
        ...m,
        status: "beta",
      })),
    );
    const plain = entryOf(build("deepseek", "deepseek-v4-pro"));

    expect([
      deprecated.model.status,
      alpha.model.status,
      beta.model.status,
      plain.model.status,
    ]).toEqual(["active", "active", "beta", "active"]);
    for (const entry of [deprecated, alpha, beta])
      expect(contract.check("JobModelEntry", entry).valid).toBe(true);
  });

  // #548-T10
  it("leaves `interleaved` out for a model that states none", () => {
    expect(
      entryOf(build("anthropic", "claude-haiku-5-5")).model,
    ).not.toHaveProperty("interleaved");
  });

  // #548-T10
  it("still serves a model that models.dev no longer lists: the last known entry is the model's entry", () => {
    const entry = entryOf(
      build("deepseek", "deepseek-v4-pro", undefined, (m) => ({
        ...m,
        unlistedAt: NOW.toISOString(),
      })),
    );

    expect(entry.modelId).toBe("deepseek-v4-pro");
  });
});

describe("refusing a provider or a model that must not reach a job", () => {
  // #548-T11
  it("lists its refusal codes", () => {
    expect([...JOB_ENTRY_REFUSAL_CODES]).toEqual([
      "provider_unsupported",
      "provider_url_blocked",
      "model_not_of_provider",
      "entry_invalid",
    ]);
  });

  // #548-T11
  it("refuses a provider that is not in the supported file", () => {
    const rows = stored();
    const bedrock: StoredProvider = {
      ...rows.provider("deepseek"),
      id: "amazon-bedrock",
    };
    const model: StoredModel = {
      ...rows.model("deepseek", "deepseek-v4-pro"),
      providerId: "amazon-bedrock",
    };

    expect(buildJobModelEntry(bedrock, model)).toEqual({
      ok: false,
      code: "provider_unsupported",
    });
    expect(
      buildJobModelEntry(
        { ...bedrock, id: "made-up" },
        { ...model, providerId: "made-up" },
      ),
    ).toEqual({ ok: false, code: "provider_unsupported" });
  });

  // #548-T08
  it("refuses a provider whose address changed and waits for an admin, for every key", () => {
    const rows = stored();
    const first = rows.provider("deepseek");
    const blocked: StoredProvider = {
      ...first,
      url: {
        state: "url_changed",
        trustedUrl: "https://api.deepseek.example/v1",
        pendingUrl: "https://evil.example/v1",
        problem: null,
      },
    };

    expect(
      buildJobModelEntry(blocked, rows.model("deepseek", "deepseek-v4-pro")),
    ).toEqual({ ok: false, code: "provider_url_blocked" });
  });

  // #548-T07
  it.each([
    [
      "http",
      { ok: false, problem: "not_https", seen: "http://api.deepseek.com" },
    ],
    [
      "private",
      { ok: false, problem: "private_address", seen: "https://10.0.0.1/v1" },
    ],
    ["unresolvable", { ok: false, problem: "unresolvable", seen: null }],
  ] as const)(
    "never lets a provider whose first address was refused (%s) into a job",
    (_name, check) => {
      expect(build("deepseek", "deepseek-v4-pro", () => check)).toEqual({
        ok: false,
        code: "provider_url_blocked",
      });
    },
  );

  // #548-T11
  it("refuses a model that belongs to another provider than the one given", () => {
    const rows = stored();

    expect(
      buildJobModelEntry(
        rows.provider("deepseek"),
        rows.model("openai", "gpt-5.5"),
      ),
    ).toEqual({ ok: false, code: "model_not_of_provider" });
  });

  // #548-T11
  it.each([
    [
      "a limit of zero",
      (m: StoredModel) => ({ ...m, limit: { context: 0, output: 0 } }),
    ],
    ["a model id that is no id", (m: StoredModel) => ({ ...m, id: "bad id" })],
    ["an empty name", (m: StoredModel) => ({ ...m, name: "" })],
  ])(
    "refuses a stored row with %s instead of handing it to the engine",
    (_name, tweak) => {
      expect(build("deepseek", "deepseek-v4-pro", undefined, tweak)).toEqual({
        ok: false,
        code: "entry_invalid",
      });
    },
  );
});

describe("the closed lists of the entry", () => {
  const entry = () => {
    const built = build("deepseek", "deepseek-v4-pro");
    if (!built.ok) throw new Error(built.code);
    return structuredClone(built.entry);
  };

  // #548-T10
  it("takes the SDKs the pinned OpenCode bundles", () => {
    for (const npm of BUNDLED_NPM)
      expect(jobModelEntrySchema.safeParse({ ...entry(), npm }).success).toBe(
        true,
      );
  });

  // #548-T10
  it.each([
    "left-pad",
    "@evil/ai-sdk-provider",
    "@ai-sdk/not-a-sdk",
    "../../etc/passwd",
    "@ai-sdk/openai ",
    "git+https://evil.example/x.git",
    "file:/tmp/x",
  ])(
    "refuses the SDK %s, which the engine would install at run time",
    (npm) => {
      expect(jobModelEntrySchema.safeParse({ ...entry(), npm }).success).toBe(
        false,
      );
    },
  );

  // #548-T10
  it("names the same fields the contract does", () => {
    const schema = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "contracts",
          "job-model-entry.v1.json",
        ),
        "utf8",
      ),
    ) as {
      $defs: {
        JobModelEntry: { properties: { npm: { enum: string[] } } };
        Interleaved: {
          oneOf: { properties?: { field: { enum: string[] } } }[];
        };
      };
    };

    expect(schema.$defs.JobModelEntry.properties.npm.enum).toEqual([
      ...BUNDLED_NPM,
    ]);
    expect(schema.$defs.Interleaved.oneOf[1]?.properties?.field.enum).toEqual([
      ...INTERLEAVED_FIELDS,
    ]);
  });

  // #548-T10
  it.each(INTERLEAVED_FIELDS)("takes the interleaved field %s", (field) => {
    const document = entry();
    document.model.interleaved = { field };

    expect(jobModelEntrySchema.safeParse(document).success).toBe(true);
  });

  // #548-T10
  it.each([
    "reasoning_text",
    "reasoning",
    "reasoning_summary",
    "x",
    "<script>",
  ])("refuses the interleaved field %s", (field) => {
    const document = {
      ...entry(),
      model: { ...entry().model, interleaved: { field } },
    };

    expect(jobModelEntrySchema.safeParse(document).success).toBe(false);
  });
});
