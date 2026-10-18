// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import { MAX_PROVIDER_TEXT_CHARS } from "../llm/provider-text.ts";
import type { SelectableEntry } from "../llm/selection.ts";
import type { ResolvedEntitlements } from "../workspaces/entitlements.ts";
import {
  refusalOf,
  selectModel,
  type SelectionDeps,
} from "./claim-selection.ts";

const JOB = { id: "job-1", reviewKind: "diff" } as Job;
const ENTRY: SelectableEntry = {
  id: "mce_a",
  name: "Thorough",
  provider: "openrouter",
  modelId: "vendor/entry-model",
  kinds: ["diff", "dynamic"],
  status: "released",
};
const MANAGED: Extract<ResolvedEntitlements, { kind: "limited" }> = {
  kind: "limited",
  source: "workspace",
  planLabel: "Team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

/** A catalog that records what it was asked. */
function catalog(
  entries: SelectableEntry[] = [ENTRY],
  defaultId: string | null = ENTRY.id,
) {
  const asked: string[] = [];
  const deps: SelectionDeps = {
    catalog: {
      get: async (id) => {
        asked.push(`get:${id}`);
        return entries.find((entry) => entry.id === id) as never;
      },
      defaults: async () => {
        asked.push("defaults");
        return { diff: defaultId, dynamic: defaultId };
      },
    },
    builtInModel: () => "vendor/built-in",
  };
  return { asked, deps };
}

describe("choosing what a job runs on", () => {
  // #432-T06
  it("asks the catalog nothing for an own job, whatever the plan lists", async () => {
    const { asked, deps } = catalog();

    const result = await selectModel(deps, JOB, {
      options: { env: {} },
      entitlements: { kind: "unlimited" },
      runnerProviders: ["openrouter"],
    });

    expect(result).toMatchObject({
      ok: true,
      selection: { keyMode: "own", model: "vendor/built-in" },
    });
    expect(asked).toEqual([]);
  });

  // #432-T03
  it("reads the one entry the project names and not the defaults", async () => {
    const { asked, deps } = catalog();

    const result = await selectModel(deps, JOB, {
      options: { env: {}, selection: { layers: {}, entryId: ENTRY.id } },
      entitlements: MANAGED,
      runnerProviders: ["openrouter"],
    });

    expect(result).toMatchObject({
      ok: true,
      selection: {
        keyMode: "managed",
        entry: { id: "mce_a", name: "Thorough", origin: "project" },
      },
    });
    expect(asked).toEqual(["get:mce_a"]);
  });

  // #432-T03
  it("reads the defaults only when the project names no entry", async () => {
    const { asked, deps } = catalog();

    await selectModel(deps, JOB, {
      options: { env: {} },
      entitlements: MANAGED,
      runnerProviders: ["openrouter"],
    });

    expect(asked).toEqual(["defaults", "get:mce_a"]);
  });

  // #432-T04
  it("refuses a managed job whose entitlements are not limited, closed", async () => {
    const { deps } = catalog();

    const result = await selectModel(deps, JOB, {
      options: { env: {} },
      entitlements: {
        kind: "invalid",
        code: "entitlements_invalid",
        source: "workspace",
      },
      runnerProviders: ["openrouter"],
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      detail: "entitlements_invalid",
    });
  });
});

describe("the detail of a refusal", () => {
  // #432-T04
  it("names the opaque entry, the kind and the reason of a managed failure, and no provider or model", () => {
    const refusal = refusalOf(
      {
        errorCode: "managed_model_unavailable",
        reason: "not_allowed",
        entryId: "mce_a",
      },
      "dynamic",
    );

    expect(refusal).toEqual({
      errorCode: "managed_model_unavailable",
      detail: "entry=mce_a kind=dynamic reason=not_allowed",
    });
  });

  // #432-T21
  it("bounds the provider an own project wrote and leaves no control character in it", () => {
    const refusal = refusalOf(
      {
        errorCode: "llm_provider_unsupported",
        reason: "provider_unsupported",
        provider: `a\n\u001b[31m${"b".repeat(10_000)}`,
      },
      "diff",
    );

    expect(refusal.errorCode).toBe("llm_provider_unsupported");
    expect(refusal.detail).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(refusal.detail.length).toBeLessThanOrEqual(
      MAX_PROVIDER_TEXT_CHARS + "kind=diff provider=".length,
    );
  });
});
