// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type {
  ModelCapabilityChecker,
  ModelCapabilityResult,
} from "../llm/model-capabilities.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { createModelTiersService } from "./service.ts";

const SUPPORTED: ModelCapabilityResult = {
  outcome: "supported",
  capabilities: {
    tools: true,
    toolChoice: true,
    toolChoiceRequired: true,
    responseFormat: true,
    structuredOutputs: true,
    maxCompletionTokens: 8192,
    smallestCompletionTokens: 8192,
    contextLength: 200_000,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
  },
};

async function start(
  answer: (modelId: string) => ModelCapabilityResult = () => SUPPORTED,
) {
  const { db } = await createTestDatabase();
  const settings = createInstanceSettingsRepository(db);
  const asked: string[] = [];
  const modelCapabilities: ModelCapabilityChecker = {
    check: async (modelId) => {
      asked.push(modelId);
      return answer(modelId);
    },
  };
  return {
    settings,
    asked,
    service: createModelTiersService({ settings, modelCapabilities }),
  };
}

describe("the managed model tiers of the instance", () => {
  // #280-T01
  it("are not configured on an instance that never saved them", async () => {
    const { service, settings } = await start();

    expect(await service.read()).toEqual({});
    expect(await service.modelFor("high", "diff")).toBeNull();
    expect(await settings.get("managed_model_tiers")).toBeUndefined();
  });

  // #280-T01
  it("are stored as they were saved and read back", async () => {
    const { service, settings } = await start();

    const saved = await service.save(
      {
        tiers: {
          low: { diff: "vendor/low-diff" },
          high: { diff: "vendor/high-diff", dynamic: "vendor/high-dyn" },
        },
      },
      null,
    );

    expect(saved).toEqual({
      ok: true,
      tiers: {
        low: { diff: "vendor/low-diff" },
        high: { diff: "vendor/high-diff", dynamic: "vendor/high-dyn" },
      },
    });
    expect(await service.read()).toEqual({
      low: { diff: "vendor/low-diff" },
      high: { diff: "vendor/high-diff", dynamic: "vendor/high-dyn" },
    });
    expect(await service.modelFor("high", "dynamic")).toBe("vendor/high-dyn");
    expect(await service.modelFor("medium", "diff")).toBeNull();
    expect(await settings.get("managed_model_tiers")).toBeDefined();
  });

  // #280-T01
  it("are replaced by a save, and an empty save removes them", async () => {
    const { service } = await start();
    await service.save({ tiers: { low: { diff: "vendor/a" } } }, null);

    await service.save({ tiers: { high: { diff: "vendor/b" } } }, null);
    expect(await service.read()).toEqual({ high: { diff: "vendor/b" } });

    await service.save({ tiers: {} }, null);
    expect(await service.read()).toEqual({});
  });

  // #280-T02
  it("refuse a Dynamic model that cannot choose a tool, and store nothing", async () => {
    const { service, settings } = await start(() => ({
      outcome: "unsupported",
      capabilities: { ...SUPPORTED.capabilities!, toolChoice: false },
    }));

    const refused = await service.save(
      { tiers: { high: { dynamic: "vendor/no-tools" } } },
      null,
    );

    expect(refused).toEqual({
      ok: false,
      code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED",
      field: "high.dynamic",
    });
    expect(await settings.get("managed_model_tiers")).toBeUndefined();
  });

  // #280-T02
  it("refuse a Dynamic model the provider does not know", async () => {
    const { service } = await start(() => ({ outcome: "unknown_model" }));

    expect(
      await service.save({ tiers: { low: { dynamic: "vendor/nope" } } }, null),
    ).toEqual({
      ok: false,
      code: "DYNAMIC_MODEL_UNKNOWN",
      field: "low.dynamic",
    });
  });

  // #280-T03
  it("refuse a Dynamic model whose metadata cannot be read, unlike the review settings", async () => {
    const { service, settings } = await start(() => ({
      outcome: "unverifiable",
    }));

    expect(
      await service.save({ tiers: { medium: { dynamic: "vendor/x" } } }, null),
    ).toEqual({
      ok: false,
      code: "DYNAMIC_MODEL_UNVERIFIED",
      field: "medium.dynamic",
    });
    expect(await settings.get("managed_model_tiers")).toBeUndefined();
  });

  it("keep what was stored when a later save is refused", async () => {
    const { service } = await start((modelId) =>
      modelId === "vendor/bad" ? { outcome: "unknown_model" } : SUPPORTED,
    );
    await service.save({ tiers: { low: { dynamic: "vendor/good" } } }, null);

    await service.save({ tiers: { low: { dynamic: "vendor/bad" } } }, null);

    expect(await service.read()).toEqual({ low: { dynamic: "vendor/good" } });
  });

  it("ask the provider about every distinct model once, in parallel", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);
    const asked: string[] = [];
    let running = 0;
    let most = 0;
    const service = createModelTiersService({
      settings,
      modelCapabilities: {
        check: async (modelId) => {
          asked.push(modelId);
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 20));
          running -= 1;
          return SUPPORTED;
        },
      },
    });

    await service.save(
      {
        tiers: {
          low: { diff: "vendor/low-diff", dynamic: "vendor/shared" },
          high: { diff: "vendor/high-diff", dynamic: "vendor/shared" },
        },
      },
      null,
    );

    expect([...asked].sort()).toEqual([
      "vendor/high-diff",
      "vendor/low-diff",
      "vendor/shared",
    ]);
    expect(most).toBe(3);
  });

  // #280-P3
  it("refuse a Diff model the provider does not know, and store nothing", async () => {
    const { service, settings } = await start((modelId) =>
      modelId === "vendor/mdel" ? { outcome: "unknown_model" } : SUPPORTED,
    );

    expect(
      await service.save({ tiers: { low: { diff: "vendor/mdel" } } }, null),
    ).toEqual({ ok: false, code: "MODEL_UNKNOWN", field: "low.diff" });
    expect(await settings.get("managed_model_tiers")).toBeUndefined();
  });

  // #280-P3
  it("accept a Diff model that needs no tool support or cannot be verified right now", async () => {
    const noTools = await start(() => ({
      outcome: "unsupported",
      capabilities: { ...SUPPORTED.capabilities!, tools: false },
    }));
    const unreachable = await start(() => ({ outcome: "unverifiable" }));

    expect(
      (
        await noTools.service.save(
          { tiers: { low: { diff: "vendor/a" } } },
          null,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await unreachable.service.save(
          { tiers: { high: { diff: "vendor/b" } } },
          null,
        )
      ).ok,
    ).toBe(true);
    expect(await unreachable.service.read()).toEqual({
      high: { diff: "vendor/b" },
    });
  });

  // #280-P3
  it("report the first refusal in the order of the tiers, whatever order the reads finish in", async () => {
    const { service } = await start(() => ({ outcome: "unknown_model" }));

    expect(
      await service.save(
        {
          tiers: {
            high: { diff: "vendor/high-diff" },
            low: { dynamic: "vendor/low-dyn" },
          },
        },
        null,
      ),
    ).toEqual({
      ok: false,
      code: "DYNAMIC_MODEL_UNKNOWN",
      field: "low.dynamic",
    });
  });

  it("refuse a body that is not valid before asking anybody", async () => {
    const { service, asked } = await start();

    expect(
      await service.save({ tiers: { low: { dynamic: "no good" } } }, null),
    ).toEqual({ ok: false, code: "model_id_invalid", field: "low.dynamic" });
    expect(await service.save({ tiers: [] }, null)).toEqual({
      ok: false,
      code: "request_invalid",
    });
    expect(asked).toEqual([]);
  });

  it("read a damaged stored value as not configured", async () => {
    const { service, settings } = await start();
    await settings.set(
      "managed_model_tiers",
      "nonsense" as unknown as Record<string, never>,
      null,
    );

    expect(await service.read()).toEqual({});
    expect(await service.modelFor("low", "diff")).toBeNull();
  });
});
