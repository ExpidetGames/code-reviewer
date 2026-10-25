// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  ENTITLEMENTS_INVALID_CODE,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";
import type { ProjectReviewKind } from "../review-settings/settings.ts";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "./providers/fake-adapter.ts";
import { openrouterDescriptor } from "./providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "./providers/registry.ts";
import {
  MANAGED_MODEL_UNAVAILABLE,
  modelProviderMismatch,
  resolveModelSelection,
  type SelectableEntry,
  type Selection,
  type SelectionInput,
} from "./selection.ts";

const BUILT_IN_DIFF_MODEL = "vendor/built-in-diff";
const BUILT_IN_DYNAMIC_MODEL = "vendor/built-in-dynamic";
const DEFAULT_PROVIDER = openrouterDescriptor.id;
// What a runner of this release advertises in the tests; a case about a provider it left out says so.
const BOTH_PROVIDERS = [DEFAULT_PROVIDER, FAKE_PROVIDER_ID];

// The registry of the app has one provider; the pairing cases need a second one, which only tests have.
const TWO_PROVIDERS = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);

type Own = Extract<SelectionInput, { keyMode: "own" }>;
type Managed = Extract<SelectionInput, { keyMode: "managed" }>;

function own(overrides: Partial<Own> = {}): Own {
  return {
    keyMode: "own",
    kind: "diff",
    runnerProviders: BOTH_PROVIDERS,
    builtInModel: BUILT_IN_DIFF_MODEL,
    layers: {},
    ...overrides,
  };
}

const LIMITS = {
  diffRunsPerPeriod: null,
  dynamicRunsPerPeriod: null,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

function limited(
  overrides: Partial<Extract<ResolvedEntitlements, { kind: "limited" }>> = {},
): Managed["entitlements"] {
  return {
    kind: "limited",
    source: "workspace",
    planLabel: "Team",
    keyMode: "managed",
    limits: LIMITS,
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

function entry(overrides: Partial<SelectableEntry> = {}): SelectableEntry {
  return {
    id: "mce_a",
    name: "Thorough",
    provider: DEFAULT_PROVIDER,
    modelId: "vendor/entry-a-model",
    kinds: ["diff", "dynamic"],
    status: "released",
    ...overrides,
  };
}

function managed(overrides: Partial<Managed> = {}): Managed {
  return {
    keyMode: "managed",
    kind: "diff",
    runnerProviders: BOTH_PROVIDERS,
    entitlements: limited(),
    projectEntryId: null,
    defaultEntryId: null,
    entries: [],
    ...overrides,
  };
}

function selected(result: ReturnType<typeof resolveModelSelection>): Selection {
  if (!result.ok) throw new Error(`not selected: ${result.reason}`);
  return result.selection;
}

describe("an own key: provider and model of the job's kind", () => {
  // #431-T01
  it.each<[ProjectReviewKind, string]>([
    ["diff", BUILT_IN_DIFF_MODEL],
    ["dynamic", BUILT_IN_DYNAMIC_MODEL],
  ])(
    "uses the default provider and the built-in model of the %s kind when nothing is set",
    (kind, builtInModel) => {
      expect(resolveModelSelection(own({ kind, builtInModel }))).toEqual({
        ok: true,
        selection: {
          keyMode: "own",
          kind,
          provider: DEFAULT_PROVIDER,
          model: builtInModel,
          keySource: "workspace",
        },
      });
    },
  );

  // #431-T02
  it("uses the provider and model the project set, for each kind", () => {
    const diff = selected(
      resolveModelSelection(
        own({
          kind: "diff",
          layers: {
            project: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
          },
        }),
        TWO_PROVIDERS,
      ),
    );
    expect(diff).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: "fake-large",
    });
    const dynamic = selected(
      resolveModelSelection(
        own({
          kind: "dynamic",
          builtInModel: BUILT_IN_DYNAMIC_MODEL,
          layers: { project: { model: "vendor/project-dynamic" } },
        }),
      ),
    );
    expect(dynamic).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: "vendor/project-dynamic",
    });
  });

  // #676-T03
  it("takes the Dynamic provider and model from the workspace default when the project sets none, and lets the project win field by field", () => {
    const layers = {
      workspace: { provider: FAKE_PROVIDER_ID, model: "fake-small" },
    };
    const inherited = selected(
      resolveModelSelection(
        own({ kind: "dynamic", builtInModel: BUILT_IN_DYNAMIC_MODEL, layers }),
        TWO_PROVIDERS,
      ),
    );
    const overridden = selected(
      resolveModelSelection(
        own({
          kind: "dynamic",
          builtInModel: BUILT_IN_DYNAMIC_MODEL,
          layers: { ...layers, project: { model: "fake-large" } },
        }),
        TWO_PROVIDERS,
      ),
    );

    expect(inherited).toMatchObject({
      kind: "dynamic",
      provider: FAKE_PROVIDER_ID,
      model: "fake-small",
    });
    expect(overridden).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: "fake-large",
    });
  });

  // #431-T02
  it("lets the project win over the workspace default, field by field", () => {
    const result = selected(
      resolveModelSelection(
        own({
          layers: {
            workspace: { provider: FAKE_PROVIDER_ID, model: "fake-small" },
            project: { model: "fake-large" },
          },
        }),
        TWO_PROVIDERS,
      ),
    );
    expect(result).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: "fake-large",
    });
  });

  // #431-T02
  it("uses the workspace default when the project sets nothing", () => {
    const result = selected(
      resolveModelSelection(
        own({
          layers: { workspace: { model: "vendor/workspace-model" } },
        }),
      ),
    );
    expect(result).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: "vendor/workspace-model",
    });
  });

  // #431-T10
  it("takes the default model of a provider the project chose without a model, not the built-in model of another provider", () => {
    const result = selected(
      resolveModelSelection(
        own({ layers: { project: { provider: FAKE_PROVIDER_ID } } }),
        TWO_PROVIDERS,
      ),
    );
    expect(result).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: "fake-small",
    });
    const dynamic = selected(
      resolveModelSelection(
        own({
          kind: "dynamic",
          layers: { project: { provider: FAKE_PROVIDER_ID } },
        }),
        TWO_PROVIDERS,
      ),
    );
    expect(dynamic).toMatchObject({ model: "fake-large" });
  });

  // #431-T11
  it("fails closed for a workspace model combined with a project provider of another provider", () => {
    expect(
      resolveModelSelection(
        own({
          layers: {
            workspace: { model: "vendor/workspace-model" },
            project: { provider: FAKE_PROVIDER_ID },
          },
        }),
        TWO_PROVIDERS,
      ),
    ).toEqual({
      ok: false,
      errorCode: "job_llm_options_invalid",
      reason: "model_provider_mismatch",
    });
  });

  // #431-T11
  it("fails closed when the project moves back to a provider and leaves the workspace's model of the other one", () => {
    expect(
      resolveModelSelection(
        own({
          layers: {
            workspace: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
            project: { provider: DEFAULT_PROVIDER },
          },
        }),
        TWO_PROVIDERS,
      ),
    ).toMatchObject({ ok: false, reason: "model_provider_mismatch" });
  });

  // #431-T11
  it("accepts a model of the project that is paired with the provider of the workspace", () => {
    const result = selected(
      resolveModelSelection(
        own({
          layers: {
            workspace: { provider: FAKE_PROVIDER_ID },
            project: { model: "fake-large" },
          },
        }),
        TWO_PROVIDERS,
      ),
    );
    expect(result).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: "fake-large",
    });
  });

  // #431-T12
  it("checks the model id against the rule of the provider that applies", () => {
    // `Fake_Large` passes no rule of the fake provider (lower case only) but is a fine OpenRouter-shaped name
    // when the provider is the default one; `vendor/x` fails the fake provider's rule.
    expect(
      resolveModelSelection(
        own({
          layers: {
            project: { provider: FAKE_PROVIDER_ID, model: "vendor/x" },
          },
        }),
        TWO_PROVIDERS,
      ),
    ).toEqual({
      ok: false,
      errorCode: "job_llm_options_invalid",
      reason: "model_invalid",
    });
    expect(
      resolveModelSelection(
        own({ layers: { project: { model: "not a model id" } } }),
      ),
    ).toMatchObject({ ok: false, reason: "model_invalid" });
  });

  // #431-T13
  it.each([
    ["a provider the app does not know", ["openrouter"], "nope"],
    [
      "a provider the runner did not advertise",
      ["openrouter"],
      FAKE_PROVIDER_ID,
    ],
  ])(
    "fails closed with llm_provider_unsupported for %s",
    (_name, runner, id) => {
      expect(
        resolveModelSelection(
          own({
            runnerProviders: runner,
            layers: { project: { provider: id, model: "fake-large" } },
          }),
          TWO_PROVIDERS,
        ),
      ).toEqual({
        ok: false,
        errorCode: "llm_provider_unsupported",
        reason: "provider_unsupported",
        provider: id,
      });
    },
  );
});

describe("the operator's key: the catalog entry of the job's kind", () => {
  // #431-T03
  it("uses the entry the project selected, with its name, provider and model", () => {
    const chosen = entry({ id: "mce_p", name: "Careful", modelId: "v/p" });
    expect(
      resolveModelSelection(
        managed({
          projectEntryId: "mce_p",
          defaultEntryId: "mce_a",
          entries: [entry(), chosen],
        }),
      ),
    ).toEqual({
      ok: true,
      selection: {
        keyMode: "managed",
        kind: "diff",
        provider: DEFAULT_PROVIDER,
        model: "v/p",
        keySource: "operator",
        entry: { id: "mce_p", name: "Careful", origin: "project" },
      },
    });
  });

  // #431-T03
  it("uses the provider of the entry, not the default provider", () => {
    const result = selected(
      resolveModelSelection(
        managed({
          runnerProviders: [DEFAULT_PROVIDER, FAKE_PROVIDER_ID],
          projectEntryId: "mce_f",
          entries: [
            entry({
              id: "mce_f",
              provider: FAKE_PROVIDER_ID,
              modelId: "fake-large",
            }),
          ],
        }),
        TWO_PROVIDERS,
      ),
    );
    expect(result).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: "fake-large",
    });
  });

  // #431-T04
  it.each<ProjectReviewKind>(["diff", "dynamic"])(
    "uses the instance default entry of the %s kind when the project selected none",
    (kind) => {
      const result = selected(
        resolveModelSelection(
          managed({
            kind,
            defaultEntryId: "mce_a",
            entries: [entry()],
          }),
        ),
      );
      expect(result).toMatchObject({
        keyMode: "managed",
        model: "vendor/entry-a-model",
        entry: { id: "mce_a", name: "Thorough", origin: "instance_default" },
      });
    },
  );

  // #431-T05
  it("fails with managed_model_unavailable and no_selection when neither the project nor the instance names an entry", () => {
    expect(resolveModelSelection(managed({ entries: [entry()] }))).toEqual({
      ok: false,
      errorCode: MANAGED_MODEL_UNAVAILABLE,
      reason: "no_selection",
    });
  });

  // #431-T06
  it.each<[string, Partial<Managed>, string]>([
    ["an id no entry has", { projectEntryId: "mce_gone" }, "missing"],
    [
      "a draft entry",
      { projectEntryId: "mce_a", entries: [entry({ status: "draft" })] },
      "not_released",
    ],
    [
      "a retired entry",
      { projectEntryId: "mce_a", entries: [entry({ status: "retired" })] },
      "not_released",
    ],
    [
      "an entry of the other kind",
      { projectEntryId: "mce_a", entries: [entry({ kinds: ["dynamic"] })] },
      "kind_mismatch",
    ],
    [
      "an entry the plan does not list",
      {
        projectEntryId: "mce_a",
        entitlements: limited({ modelAccess: { catalogEntries: ["mce_b"] } }),
      },
      "not_allowed",
    ],
    [
      "an entry the plan allows none of",
      {
        projectEntryId: "mce_a",
        entitlements: limited({ modelAccess: { catalogEntries: [] } }),
      },
      "not_allowed",
    ],
    [
      "an entry of a provider the app does not know",
      { projectEntryId: "mce_a", entries: [entry({ provider: "nope" })] },
      "provider_unsupported",
    ],
    [
      "an entry of a provider the runner did not advertise",
      {
        projectEntryId: "mce_a",
        runnerProviders: [DEFAULT_PROVIDER],
        entries: [entry({ provider: FAKE_PROVIDER_ID })],
      },
      "provider_unsupported",
    ],
    [
      "a default entry that is retired",
      {
        defaultEntryId: "mce_a",
        entries: [entry({ status: "retired" })],
      },
      "not_released",
    ],
  ])("maps %s to its reason", (_name, overrides, reason) => {
    expect(
      resolveModelSelection(
        managed({ entries: [entry()], ...overrides }),
        TWO_PROVIDERS,
      ),
    ).toEqual({
      ok: false,
      errorCode: MANAGED_MODEL_UNAVAILABLE,
      reason,
      ...(overrides.projectEntryId === "mce_gone"
        ? { entryId: "mce_gone" }
        : { entryId: "mce_a" }),
    });
  });

  // #431-T06
  describe.each<[string, Partial<Managed>]>([
    ["a project entry", { projectEntryId: "mce_a", defaultEntryId: null }],
    [
      "the instance default entry",
      { projectEntryId: null, defaultEntryId: "mce_a" },
    ],
    [
      "the instance default entry when the project id is undefined",
      {
        projectEntryId: undefined,
        defaultEntryId: "mce_a",
      } as Partial<Managed>,
    ],
  ])("the reasons for %s", (_origin, ids) => {
    it.each<[string, Partial<Managed>, string]>([
      ["an id no entry has", { entries: [] }, "missing"],
      [
        "a draft entry",
        { entries: [entry({ status: "draft" })] },
        "not_released",
      ],
      [
        "a retired entry",
        { entries: [entry({ status: "retired" })] },
        "not_released",
      ],
      [
        "an entry of the other kind",
        { entries: [entry({ kinds: ["dynamic"] })] },
        "kind_mismatch",
      ],
      [
        "an entry the plan does not list",
        {
          entitlements: limited({ modelAccess: { catalogEntries: ["mce_b"] } }),
        },
        "not_allowed",
      ],
      [
        "an entry when the plan allows none",
        { entitlements: limited({ modelAccess: { catalogEntries: [] } }) },
        "not_allowed",
      ],
      [
        "an entry of a provider the app does not know",
        { entries: [entry({ provider: "nope" })] },
        "provider_unsupported",
      ],
      [
        "an entry of a provider the runner did not advertise",
        {
          runnerProviders: [DEFAULT_PROVIDER],
          entries: [entry({ provider: FAKE_PROVIDER_ID })],
        },
        "provider_unsupported",
      ],
    ])("maps %s to its reason", (_name, overrides, reason) => {
      expect(
        resolveModelSelection(
          managed({ entries: [entry()], ...ids, ...overrides }),
          TWO_PROVIDERS,
        ),
      ).toEqual({
        ok: false,
        errorCode: MANAGED_MODEL_UNAVAILABLE,
        reason,
        entryId: "mce_a",
      });
    });
  });

  // #431-T03
  it("labels the origin of the entry by one rule: a null or undefined project id selects the instance default", () => {
    const origins = [null, undefined, "mce_p"].map((projectEntryId) => {
      const result = resolveModelSelection(
        managed({
          projectEntryId: projectEntryId as string | null,
          defaultEntryId: "mce_a",
          entries: [entry(), entry({ id: "mce_p" })],
        }),
      );
      const chosen = selected(result);
      return [chosen.entry?.id, chosen.entry?.origin];
    });
    expect(origins).toEqual([
      ["mce_a", "instance_default"],
      ["mce_a", "instance_default"],
      ["mce_p", "project"],
    ]);
  });

  // #431-T06
  it("checks the reasons in a fixed order: missing, released, kind, plan, provider", () => {
    const worst = entry({
      status: "draft",
      kinds: ["dynamic"],
      provider: "nope",
    });
    const input = (e: SelectableEntry, access: string[] | null) =>
      managed({
        projectEntryId: "mce_a",
        entries: [e],
        entitlements: limited({ modelAccess: { catalogEntries: access } }),
      });
    const reasonOf = (e: SelectableEntry, access: string[] | null) => {
      const result = resolveModelSelection(input(e, access), TWO_PROVIDERS);
      return result.ok ? "ok" : result.reason;
    };
    expect(reasonOf(worst, [])).toBe("not_released");
    expect(reasonOf({ ...worst, status: "released" }, [])).toBe(
      "kind_mismatch",
    );
    expect(
      reasonOf({ ...worst, status: "released", kinds: ["diff"] }, []),
    ).toBe("not_allowed");
    expect(
      reasonOf({ ...worst, status: "released", kinds: ["diff"] }, null),
    ).toBe("provider_unsupported");
  });

  // #431-T06
  it.each<[string, SelectableEntry[], string]>([
    ["is no entry", [], "missing"],
    ["is retired", [entry({ id: "mce_p", status: "retired" })], "not_released"],
    [
      "serves the other kind",
      [entry({ id: "mce_p", kinds: ["dynamic"] })],
      "kind_mismatch",
    ],
    [
      "has a provider the app does not know",
      [entry({ id: "mce_p", provider: "nope" })],
      "provider_unsupported",
    ],
  ])(
    "never falls back: a project entry that %s does not move the job to the instance default entry",
    (_name, projectEntries, reason) => {
      expect(
        resolveModelSelection(
          managed({
            projectEntryId: "mce_p",
            defaultEntryId: "mce_a",
            entries: [entry(), ...projectEntries],
          }),
        ),
      ).toEqual({
        ok: false,
        errorCode: MANAGED_MODEL_UNAVAILABLE,
        reason,
        entryId: "mce_p",
      });
    },
  );

  // #431-T06
  it("never falls back to another entry when the plan does not allow the project's entry", () => {
    expect(
      resolveModelSelection(
        managed({
          projectEntryId: "mce_p",
          defaultEntryId: "mce_a",
          entitlements: limited({
            modelAccess: { catalogEntries: ["mce_a"] },
          }),
          entries: [entry(), entry({ id: "mce_p" })],
        }),
      ),
    ).toMatchObject({ ok: false, reason: "not_allowed", entryId: "mce_p" });
  });

  // #431-T06
  it("never names the provider or the model of an entry in a failure", () => {
    const result = resolveModelSelection(
      managed({
        projectEntryId: "mce_a",
        entries: [entry({ status: "retired", modelId: "secret/model-x" })],
      }),
    );
    expect(JSON.stringify(result)).not.toContain("secret/model-x");
    expect(JSON.stringify(result)).not.toContain(DEFAULT_PROVIDER);
  });

  // #431-T14
  it("allows every released entry for a plan without a model list", () => {
    for (const modelAccess of [undefined, { catalogEntries: null }]) {
      expect(
        resolveModelSelection(
          managed({
            projectEntryId: "mce_a",
            entries: [entry()],
            entitlements: limited(
              modelAccess === undefined ? {} : { modelAccess },
            ),
          }),
        ),
      ).toMatchObject({ ok: true });
    }
  });

  // #431-T15
  it("fails closed when the managed branch is handed entitlements that are not managed", () => {
    expect(
      resolveModelSelection(
        managed({
          projectEntryId: "mce_a",
          entries: [entry()],
          entitlements: limited({ keyMode: "own" }),
        }),
      ),
    ).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: ENTITLEMENTS_INVALID_CODE,
    });
  });
});

describe("entitlements that cannot be read", () => {
  // #431-T07
  it("fails closed and selects nothing", () => {
    expect(resolveModelSelection({ keyMode: "unreadable" })).toEqual({
      ok: false,
      errorCode: "llm_not_configured",
      reason: ENTITLEMENTS_INVALID_CODE,
    });
  });
});

// A deterministic generator: a test brings its own randomness (TESTING.md, section 1).
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Puts members on the input that the branch must never read: reading one is recorded and throws. */
function withTraps<T extends object>(
  input: T,
  traps: readonly string[],
  touched: string[],
): T {
  const copy = { ...input };
  for (const name of traps)
    Object.defineProperty(copy, name, {
      enumerable: true,
      get() {
        touched.push(name);
        throw new Error(`read ${name}`);
      },
    });
  return copy;
}

describe("the branches read only their own fields", () => {
  const OWN_FIELDS = ["builtInModel", "layers"];
  const MANAGED_FIELDS = [
    "entitlements",
    "projectEntryId",
    "defaultEntryId",
    "entries",
  ];

  function randomOwn(next: () => number): Own {
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(next() * values.length)] as T;
    const layer = () => ({
      ...(next() < 0.5 ? { provider: pick(["openrouter", "nope"]) } : {}),
      ...(next() < 0.5
        ? { model: pick(["vendor/a", "vendor/b", "not valid"]) }
        : {}),
    });
    return own({
      kind: pick(["diff", "dynamic"] as const),
      layers: {
        ...(next() < 0.6 ? { workspace: layer() } : {}),
        ...(next() < 0.6 ? { project: layer() } : {}),
      },
    });
  }

  function randomManaged(next: () => number): Managed {
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(next() * values.length)] as T;
    const ids = ["mce_a", "mce_b", "mce_c"];
    return managed({
      kind: pick(["diff", "dynamic"] as const),
      projectEntryId: pick([null, ...ids]),
      defaultEntryId: pick([null, ...ids]),
      entitlements: limited({
        modelAccess: { catalogEntries: pick([null, [], ["mce_a"], ids]) },
      }),
      entries: ids.map((id) =>
        entry({
          id,
          status: pick(["released", "draft", "retired"] as const),
          kinds: pick([["diff"], ["dynamic"], ["diff", "dynamic"]] as const),
          provider: pick(["openrouter", "nope"]),
        }),
      ),
    });
  }

  // #431-T08
  it("a managed job never reads a field of the own mode, over random settings", () => {
    const next = random(431);
    for (let round = 0; round < 300; round += 1) {
      const input = randomManaged(next);
      const touched: string[] = [];
      const trapped = withTraps(input, OWN_FIELDS, touched);
      expect(resolveModelSelection(trapped)).toEqual(
        resolveModelSelection(input),
      );
      expect(touched).toEqual([]);
    }
  });

  // #431-T08
  it("an own job never reads a field of the catalog, over random settings", () => {
    const next = random(432);
    for (let round = 0; round < 300; round += 1) {
      const input = randomOwn(next);
      const touched: string[] = [];
      const trapped = withTraps(input, MANAGED_FIELDS, touched);
      const result = resolveModelSelection(trapped);
      expect(result).toEqual(resolveModelSelection(input));
      expect(touched).toEqual([]);
      if (result.ok) expect(result.selection).not.toHaveProperty("entry");
    }
  });

  // #431-T08
  it("an unreadable job reads nothing else", () => {
    const touched: string[] = [];
    const trapped = withTraps(
      { keyMode: "unreadable" as const },
      [...OWN_FIELDS, ...MANAGED_FIELDS, "kind", "runnerProviders"],
      touched,
    );
    expect(resolveModelSelection(trapped)).toMatchObject({ ok: false });
    expect(touched).toEqual([]);
  });

  // #431-T16
  it("an own job does not evaluate modelAccess, whatever the plan lists", () => {
    const touched: string[] = [];
    const trapped = withTraps(own(), ["entitlements"], touched);
    expect(resolveModelSelection(trapped)).toMatchObject({ ok: true });
    expect(touched).toEqual([]);
  });

  // #431-T17
  it("is deterministic and leaves its input as it was", () => {
    const next = random(433);
    for (let round = 0; round < 100; round += 1) {
      const input = round % 2 === 0 ? randomOwn(next) : randomManaged(next);
      const before = JSON.stringify(input);
      const first = resolveModelSelection(input);
      expect(resolveModelSelection(input)).toEqual(first);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});

describe("the shape of a selection", () => {
  const ENTRY = { id: "mce_a", name: "Thorough", origin: "project" } as const;
  const BASE = {
    kind: "diff",
    provider: DEFAULT_PROVIDER,
    model: "vendor/m",
  } as const;
  const OWN_SELECTION = {
    ...BASE,
    keyMode: "own",
    keySource: "workspace",
  } as const;
  const MANAGED_SELECTION = {
    ...BASE,
    keyMode: "managed",
    keySource: "operator",
    entry: ENTRY,
  } as const;
  const takesSelection = (selection: Selection): Selection => selection;
  const takesOwn = (input: Own): Own => input;
  const takesManaged = (input: Managed): Managed => input;

  // #431-T09
  it("has no place for an entry in an own selection and none for the workspace's key in a managed one", () => {
    expect(takesSelection(OWN_SELECTION).keyMode).toBe("own");
    expect(takesSelection(MANAGED_SELECTION).keyMode).toBe("managed");

    const rejected = [
      // @ts-expect-error an own selection cannot carry an entry
      takesSelection({ ...OWN_SELECTION, entry: ENTRY }),
      // @ts-expect-error an own selection cannot be keyed by the operator's key
      takesSelection({ ...OWN_SELECTION, keySource: "operator" }),
      // @ts-expect-error a managed selection cannot be keyed by the workspace's key
      takesSelection({ ...MANAGED_SELECTION, keySource: "workspace" }),
      // @ts-expect-error a managed selection needs its entry
      takesSelection({ ...BASE, keyMode: "managed", keySource: "operator" }),
    ];
    expect(rejected).toHaveLength(4);
  });

  // #431-T09
  it("has no place for the entries in the own input and none for the own fields in the managed input", () => {
    const rejected = [
      // @ts-expect-error the own input has no entries
      takesOwn({ ...own(), entries: [] }),
      // @ts-expect-error the own input has no entitlements, so no modelAccess
      takesOwn({ ...own(), entitlements: limited() }),
      // @ts-expect-error the managed input has no own layers
      takesManaged({ ...managed(), layers: {} }),
      // @ts-expect-error the managed input has no built-in model
      takesManaged({ ...managed(), builtInModel: "vendor/m" }),
      // @ts-expect-error the managed input takes limited entitlements only
      takesManaged({ ...managed(), entitlements: { kind: "unlimited" } }),
    ];
    expect(rejected).toHaveLength(5);
  });
});

// #432-T17 (binding comment of #459): the save path refuses the pairing the resolver would fail at the claim, with the
// same rule: the model of a layer only counts for the provider in force where it was set.
describe("the pairing of a model with a provider across layers", () => {
  const layerPairs: [string, Own["layers"]][] = [
    ["nothing set", {}],
    ["a project provider only", { project: { provider: FAKE_PROVIDER_ID } }],
    [
      "a workspace model of the default provider and a project provider",
      {
        workspace: { model: "vendor/workspace-model" },
        project: { provider: FAKE_PROVIDER_ID },
      },
    ],
    [
      "a workspace provider and model and a project provider back to the default",
      {
        workspace: { provider: FAKE_PROVIDER_ID, model: "fake-large" },
        project: { provider: DEFAULT_PROVIDER },
      },
    ],
    [
      "a workspace provider and a project model",
      {
        workspace: { provider: FAKE_PROVIDER_ID },
        project: { model: "fake-large" },
      },
    ],
    [
      "a project provider with its own model",
      { project: { provider: FAKE_PROVIDER_ID, model: "fake-large" } },
    ],
    ["a workspace model only", { workspace: { model: "vendor/m" } }],
  ];

  it("refuses a project provider next to a workspace model of another provider", () => {
    expect(
      modelProviderMismatch(
        { provider: FAKE_PROVIDER_ID, model: "fake-large" },
        { provider: DEFAULT_PROVIDER },
        DEFAULT_PROVIDER,
      ),
    ).toBe(true);
    expect(
      modelProviderMismatch(
        { model: "vendor/workspace-model" },
        { provider: FAKE_PROVIDER_ID },
        DEFAULT_PROVIDER,
      ),
    ).toBe(true);
  });

  it("accepts the same provider change when the project brings a model of the new provider", () => {
    expect(
      modelProviderMismatch(
        { model: "vendor/workspace-model" },
        { provider: FAKE_PROVIDER_ID, model: "fake-large" },
        DEFAULT_PROVIDER,
      ),
    ).toBe(false);
    expect(
      modelProviderMismatch(undefined, { provider: FAKE_PROVIDER_ID }, "x"),
    ).toBe(false);
  });

  it.each(layerPairs)("agrees with the resolver on %s", (_name, layers) => {
    const result = resolveModelSelection(own({ layers }), TWO_PROVIDERS);
    const resolverSaysMismatch =
      !result.ok && result.reason === "model_provider_mismatch";
    expect(
      modelProviderMismatch(layers.workspace, layers.project, DEFAULT_PROVIDER),
    ).toBe(resolverSaysMismatch);
  });
});
