// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  PERIOD_START_FUTURE_TOLERANCE_MS,
  checkPeriodStartNotBackwards,
  readEntitlements,
  validateEntitlements,
  validateLimits,
} from "./entitlements-validation.ts";

const NOW = new Date("2026-10-14T12:00:00.000Z");

function limits(overrides: Record<string, unknown> = {}): unknown {
  return {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
    ...overrides,
  };
}

/** The limits of an entry without one of them, as an entry stored before that limit existed has it. */
function limitsWithout(name: string): unknown {
  return Object.fromEntries(
    Object.entries(limits() as Record<string, unknown>).filter(
      ([key]) => key !== name,
    ),
  );
}

function input(overrides: Record<string, unknown> = {}): unknown {
  return {
    planLabel: "team",
    // "managed": the own key takes no cost limit (#277), and the default input carries one.
    keyMode: "managed",
    limits: limits({ diffRunsPerPeriod: 10, managedCostLimitMicroUsd: 0 }),
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

describe("validating entitlements", () => {
  it("accepts a valid set and returns it in canonical form", () => {
    expect(
      validateEntitlements(input({ periodStart: "2026-10-01T02:00:00Z" }), NOW),
    ).toEqual({
      ok: true,
      value: {
        planLabel: "team",
        keyMode: "managed",
        limits: {
          diffRunsPerPeriod: 10,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: 0,
          ownKeyCostLimitMicroUsd: null,
        },
        periodStart: "2026-10-01T02:00:00.000Z",
        suspended: false,
        suspensionCode: null,
        modelAccess: { catalogEntries: null },
      },
    });
  });

  it("accepts the largest safe integer as a limit", () => {
    const result = validateEntitlements(
      input({ limits: limits({ diffRunsPerPeriod: 2 ** 53 - 1 }) }),
      NOW,
    );

    expect(result.ok).toBe(true);
  });

  // #271-T04
  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "10"],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["above 2^53-1", 2 ** 53],
    ["undefined", undefined],
    ["a boolean", true],
  ])("refuses a limit that is %s", (_name, value) => {
    expect(
      validateEntitlements(
        input({ limits: limits({ dynamicRunsPerPeriod: value }) }),
        NOW,
      ),
    ).toEqual({
      ok: false,
      code: "limit_invalid",
      field: "dynamicRunsPerPeriod",
    });
  });

  // #271-T04
  it("refuses limits that are not an object, miss a key or name an unknown one", () => {
    for (const bad of [
      null,
      "10",
      [],
      { diffRunsPerPeriod: 1 },
      { ...(limits() as object), extra: 1 },
    ])
      expect(validateEntitlements(input({ limits: bad }), NOW)).toMatchObject({
        ok: false,
        code: "limits_invalid",
      });
  });

  // #271-T04
  it.each(["", "OWN", "shared", null, 1, undefined])(
    "refuses the key mode %j",
    (keyMode) => {
      expect(validateEntitlements(input({ keyMode }), NOW)).toEqual({
        ok: false,
        code: "key_mode_invalid",
      });
    },
  );

  // #271-T04
  it.each([
    ["empty", ""],
    ["overlong", "a".repeat(65)],
    ["with a line break", "team\nplus"],
    ["with a tab", "team\tplus"],
    ["with a NUL", "team\u0000"],
    ["with an escape", "team\u001b[31m"],
    ["with a bidi override", "team‮plus"],
    ["not text", 5],
  ])("refuses a plan label that is %s", (_name, planLabel) => {
    expect(validateEntitlements(input({ planLabel }), NOW)).toEqual({
      ok: false,
      code: "plan_label_invalid",
    });
  });

  it("counts the length of a label in characters, not in bytes", () => {
    expect(
      validateEntitlements(input({ planLabel: "é".repeat(64) }), NOW).ok,
    ).toBe(true);
    expect(
      validateEntitlements(input({ planLabel: "😀".repeat(64) }), NOW).ok,
    ).toBe(true);
    expect(
      validateEntitlements(input({ planLabel: "😀".repeat(65) }), NOW).ok,
    ).toBe(false);
  });

  // #271-T04
  it.each([
    ["not text", 1760000000000],
    ["not a time", "yesterday"],
    ["a date without a time", "2026-10-01"],
    ["a time with an offset", "2026-10-01T00:00:00+02:00"],
    ["a day that does not exist", "2026-02-31T00:00:00Z"],
  ])("refuses a period start that is %s", (_name, periodStart) => {
    expect(validateEntitlements(input({ periodStart }), NOW)).toEqual({
      ok: false,
      code: "period_start_invalid",
    });
  });

  it("allows a period start a few minutes in the future and refuses a later one", () => {
    const edge = new Date(NOW.getTime() + PERIOD_START_FUTURE_TOLERANCE_MS);
    const later = new Date(edge.getTime() + 1);

    expect(
      validateEntitlements(input({ periodStart: edge.toISOString() }), NOW).ok,
    ).toBe(true);
    expect(
      validateEntitlements(input({ periodStart: later.toISOString() }), NOW),
    ).toEqual({ ok: false, code: "period_start_in_future" });
  });

  it("refuses a suspended flag that is not a boolean", () => {
    expect(validateEntitlements(input({ suspended: 1 }), NOW)).toEqual({
      ok: false,
      code: "suspended_invalid",
    });
  });

  it.each(["", "Payment", "has space", "a".repeat(65), "1abc", 5])(
    "refuses the suspension code %j",
    (suspensionCode) => {
      expect(
        validateEntitlements(input({ suspended: true, suspensionCode }), NOW),
      ).toEqual({ ok: false, code: "suspension_code_invalid" });
    },
  );

  // #271-T09
  it("keeps a suspension code only while suspended", () => {
    expect(
      validateEntitlements(
        input({ suspended: true, suspensionCode: "payment_overdue" }),
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      value: { suspended: true, suspensionCode: "payment_overdue" },
    });
    expect(
      validateEntitlements(
        input({ suspended: false, suspensionCode: "payment_overdue" }),
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      value: { suspended: false, suspensionCode: null },
    });
  });

  // #271-T04
  it.each(["BAD CODE!", 5, ""])(
    "refuses the garbage suspension code %j even when the workspace is not suspended",
    (suspensionCode) => {
      expect(
        validateEntitlements(input({ suspended: false, suspensionCode }), NOW),
      ).toEqual({ ok: false, code: "suspension_code_invalid" });
    },
  );

  // #271-T04
  it.each([
    ["only spaces", "   "],
    ["a no-break space", "\u00a0"],
    ["a Hangul filler", "\u3164"],
    ["Hangul fillers and spaces", " \u3164\u115f\uffa0 "],
    ["a blank braille pattern", "\u2800"],
    ["only combining marks", "\u0301\u0302"],
    ["a private use character", "team\ue000"],
    ["a line separator", "team\u2028plus"],
  ])("refuses a plan label that is %s", (_name, planLabel) => {
    expect(validateEntitlements(input({ planLabel }), NOW)).toEqual({
      ok: false,
      code: "plan_label_invalid",
    });
  });

  it("accepts labels with inner spaces, accents and non-Latin letters", () => {
    for (const planLabel of ["Team plus", "Équipe", "チーム", "plan-2 (beta)"])
      expect(validateEntitlements(input({ planLabel }), NOW).ok).toBe(true);
  });

  // #271-T04
  it("refuses an unknown top-level key, like an unknown limit", () => {
    expect(validateEntitlements(input({ admin: true }), NOW)).toEqual({
      ok: false,
      code: "entitlements_invalid",
      field: "admin",
    });
  });

  it("refuses an input that is not an object", () => {
    for (const bad of [null, undefined, "x", 1, []])
      expect(validateEntitlements(bad, NOW)).toMatchObject({ ok: false });
  });
});

describe("the cost limit and the key mode (#277)", () => {
  // #277-P2
  it("refuses a cost limit, even 0, next to the own key: nothing would read it", () => {
    for (const cost of [0, 5_000_000])
      expect(
        validateEntitlements(
          input({
            keyMode: "own",
            limits: limits({ managedCostLimitMicroUsd: cost }),
          }),
          NOW,
        ),
      ).toEqual({
        ok: false,
        code: "cost_limit_requires_managed_key",
        field: "managedCostLimitMicroUsd",
      });
  });

  // #277-P2
  it("accepts a cost limit with the managed key, and the own key without one", () => {
    expect(
      validateEntitlements(
        input({
          keyMode: "managed",
          limits: limits({ managedCostLimitMicroUsd: 5_000_000 }),
        }),
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateEntitlements(input({ keyMode: "own", limits: limits() }), NOW),
    ).toMatchObject({ ok: true });
  });

  // #277-P2
  it("still reads a stored entry of that shape, so an existing entry keeps working", () => {
    expect(
      readEntitlements(
        input({
          keyMode: "own",
          limits: limits({ managedCostLimitMicroUsd: 5_000_000 }),
        }),
      ),
    ).toMatchObject({
      keyMode: "own",
      limits: { managedCostLimitMicroUsd: 5_000_000 },
    });
  });

  // #277-P2
  it("reports a bad key mode before the cost limit", () => {
    expect(
      validateEntitlements(
        input({
          keyMode: "shared",
          limits: limits({ managedCostLimitMicroUsd: 1 }),
        }),
        NOW,
      ),
    ).toEqual({ ok: false, code: "key_mode_invalid" });
  });
});

describe("the cost limit of the own key (#361)", () => {
  // #361-T11
  it("accepts a count, 0 and null, and refuses what is not a count", () => {
    for (const keyMode of ["own", "managed"])
      for (const cost of [null, 0, 1, 2 ** 53 - 1])
        expect(
          validateEntitlements(
            input({
              keyMode,
              limits: limits({ ownKeyCostLimitMicroUsd: cost }),
            }),
            NOW,
          ),
        ).toMatchObject({
          ok: true,
          value: { limits: { ownKeyCostLimitMicroUsd: cost } },
        });
    for (const bad of [-1, 1.5, "5", 2 ** 53, true, undefined])
      expect(
        validateEntitlements(
          input({
            keyMode: "own",
            limits: limits({ ownKeyCostLimitMicroUsd: bad }),
          }),
          NOW,
        ),
      ).toEqual({
        ok: false,
        code: "limit_invalid",
        field: "ownKeyCostLimitMicroUsd",
      });
  });

  // #361-T11
  it("is allowed next to the own key, where the managed cost limit is still refused", () => {
    expect(
      validateEntitlements(
        input({
          keyMode: "own",
          limits: limits({ ownKeyCostLimitMicroUsd: 5_000_000 }),
        }),
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateEntitlements(
        input({
          keyMode: "own",
          limits: limits({
            managedCostLimitMicroUsd: 1,
            ownKeyCostLimitMicroUsd: 5_000_000,
          }),
        }),
        NOW,
      ),
    ).toEqual({
      ok: false,
      code: "cost_limit_requires_managed_key",
      field: "managedCostLimitMicroUsd",
    });
  });

  // #361-T11
  it("is required on a write, like every limit", () => {
    const without = limitsWithout("ownKeyCostLimitMicroUsd");

    expect(validateEntitlements(input({ limits: without }), NOW)).toMatchObject(
      { ok: false, code: "limits_invalid" },
    );
  });

  // #361-T01
  it("reads as unlimited when an entry stored before the limit existed lacks it", () => {
    const before = limitsWithout("ownKeyCostLimitMicroUsd");

    expect(readEntitlements(input({ limits: before }))).toMatchObject({
      limits: { ownKeyCostLimitMicroUsd: null },
    });
  });

  // #361-T11
  it("is not defaulted on read when it is stored but damaged", () => {
    expect(
      readEntitlements(
        input({ limits: limits({ ownKeyCostLimitMicroUsd: "5" }) }),
      ),
    ).toBeUndefined();
  });
});

describe("validating limits", () => {
  it("treats a missing key as unlimited only for a limit that is declared as added later", () => {
    const partial = { diffRunsPerPeriod: 1, managedCostLimitMicroUsd: null };

    expect(validateLimits(partial, [])).toMatchObject({
      ok: false,
      code: "limits_invalid",
    });
    expect(
      validateLimits(partial, [
        "dynamicRunsPerPeriod",
        "ownKeyCostLimitMicroUsd",
      ]),
    ).toEqual({
      ok: true,
      value: {
        diffRunsPerPeriod: 1,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: null,
        ownKeyCostLimitMicroUsd: null,
      },
    });
  });
});

describe("reading stored entitlements", () => {
  const stored = {
    planLabel: "team",
    keyMode: "managed",
    limits: {
      diffRunsPerPeriod: 1,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: 0,
      ownKeyCostLimitMicroUsd: 2_000_000,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: true,
    suspensionCode: "payment_overdue",
  };

  // #271-T10
  it("returns the data of a valid entry", () => {
    // #428-T05: an entry without the model access reads as "every released entry".
    expect(readEntitlements(stored)).toEqual({
      ...stored,
      modelAccess: { catalogEntries: null },
    });
  });

  // #271-T10
  it.each([
    ["limits that are an empty object", { ...stored, limits: {} }],
    [
      "a limit that is not a count",
      { ...stored, limits: { ...stored.limits, diffRunsPerPeriod: "1" } },
    ],
    ["a key mode the code does not know", { ...stored, keyMode: "shared" }],
    [
      "a period start that is not canonical",
      { ...stored, periodStart: "yesterday" },
    ],
    ["a suspension code without suspension", { ...stored, suspended: false }],
    ["JSON text that is damaged", undefined],
    ["null", null],
  ])("reads %s as unreadable", (_name, entry) => {
    expect(readEntitlements(entry)).toBeUndefined();
  });

  // #271-T10
  it("does not read a period start in the future as unreadable (the clock is not asked)", () => {
    expect(
      readEntitlements({ ...stored, periodStart: "2099-01-01T00:00:00.000Z" }),
    ).toMatchObject({ periodStart: "2099-01-01T00:00:00.000Z" });
  });

  // #271-T10
  it("ignores keys it does not know, so an older app can read what a newer one wrote", () => {
    expect(
      readEntitlements({
        ...stored,
        newField: 1,
        limits: { ...stored.limits, newLimit: 5 },
      }),
    ).toEqual({ ...stored, modelAccess: { catalogEntries: null } });
  });
});

describe("checking that a period start does not go backwards", () => {
  // #271-T05
  it("refuses an earlier value, and accepts a later one, the same one and a first one", () => {
    const stored = "2026-10-01T00:00:00.000Z";

    expect(
      checkPeriodStartNotBackwards("2026-09-30T23:59:59.999Z", stored),
    ).toBe("period_start_backwards");
    expect(checkPeriodStartNotBackwards(stored, stored)).toBeUndefined();
    expect(
      checkPeriodStartNotBackwards("2026-10-01T00:00:00.001Z", stored),
    ).toBeUndefined();
    expect(checkPeriodStartNotBackwards(stored, undefined)).toBeUndefined();
  });
});

describe("the model access (#428)", () => {
  const ID_A = "mce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ID_B = "mce_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const manyIds = (count: number) =>
    Array.from(
      { length: count },
      (_unused, index) => `mce_${String(index).padStart(32, "0")}`,
    );

  // #428-T05
  it("is optional on a write and reads as every released entry", () => {
    expect(validateEntitlements(input(), NOW)).toMatchObject({
      ok: true,
      value: { modelAccess: { catalogEntries: null } },
    });
  });

  it("accepts null, an empty list, listed ids and ids that no entry has", () => {
    for (const catalogEntries of [null, [], [ID_A], [ID_A, ID_B], manyIds(100)])
      expect(
        validateEntitlements(input({ modelAccess: { catalogEntries } }), NOW),
      ).toMatchObject({
        ok: true,
        value: { modelAccess: { catalogEntries } },
      });
  });

  // #428-T03
  it.each([
    ["a string", { catalogEntries: "all" }],
    ["an object", { catalogEntries: { [ID_A]: true } }],
    ["a missing list", {}],
    ["a number in the list", { catalogEntries: [1] }],
    ["null in the list", { catalogEntries: [null] }],
    ["an empty id", { catalogEntries: [""] }],
    ["an id with a space", { catalogEntries: [`${ID_A} `] }],
    ["an id with a slash", { catalogEntries: ["vendor/model"] }],
    [
      "an id that is far too long",
      { catalogEntries: [`mce_${"a".repeat(80)}`] },
    ],
    ["more than 100 ids", { catalogEntries: manyIds(101) }],
    ["a key it does not know", { catalogEntries: null, extra: 1 }],
  ])("refuses %s with catalog_entry_invalid", (_name, modelAccess) => {
    expect(validateEntitlements(input({ modelAccess }), NOW)).toMatchObject({
      ok: false,
      code: "catalog_entry_invalid",
    });
  });

  // #428-T03
  it.each([
    ["null", null],
    ["a string", "all"],
    ["a list", [ID_A]],
    ["a number", 1],
  ])("refuses a model access that is %s", (_name, modelAccess) => {
    expect(validateEntitlements(input({ modelAccess }), NOW)).toMatchObject({
      ok: false,
      code: "catalog_entry_invalid",
      field: "modelAccess",
    });
  });

  // #428-T10
  it("is accepted next to the own key, so that a switch back to the managed key finds it", () => {
    expect(
      validateEntitlements(
        input({
          keyMode: "own",
          limits: limits(),
          modelAccess: { catalogEntries: [ID_A] },
        }),
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      value: { keyMode: "own", modelAccess: { catalogEntries: [ID_A] } },
    });
  });

  describe("when reading", () => {
    // #428-T05
    it("reads a missing field as null and a stored list as it is", () => {
      expect(readEntitlements(input())).toMatchObject({
        modelAccess: { catalogEntries: null },
      });
      expect(
        readEntitlements(input({ modelAccess: { catalogEntries: [ID_A] } })),
      ).toMatchObject({ modelAccess: { catalogEntries: [ID_A] } });
      expect(
        readEntitlements(input({ modelAccess: { catalogEntries: [] } })),
      ).toMatchObject({ modelAccess: { catalogEntries: [] } });
    });

    // #428-T05
    it("ignores a key of a newer version inside the field", () => {
      expect(
        readEntitlements(
          input({ modelAccess: { catalogEntries: [ID_A], newer: true } }),
        ),
      ).toMatchObject({ modelAccess: { catalogEntries: [ID_A] } });
    });

    // #428-T05
    it.each([
      ["a string", "all"],
      ["a field without a list", {}],
      ["a list of numbers", { catalogEntries: [1] }],
      ["more than 100 ids", { catalogEntries: manyIds(101) }],
    ])("reads %s as unreadable: damaged data grants no model", (_n, value) => {
      expect(readEntitlements(input({ modelAccess: value }))).toBeUndefined();
    });

    // #428-T10
    it("reads a list next to the own key", () => {
      expect(
        readEntitlements(
          input({
            keyMode: "own",
            limits: limits(),
            modelAccess: { catalogEntries: [ID_A] },
          }),
        ),
      ).toMatchObject({
        keyMode: "own",
        modelAccess: { catalogEntries: [ID_A] },
      });
    });
  });
});
