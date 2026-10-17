// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  entryAllowed,
  INVALID_ENTITLEMENTS,
  resolveEntitlements,
  type EntitlementsData,
} from "./entitlements.ts";

const NO_LIMITS = {
  diffRunsPerPeriod: null,
  dynamicRunsPerPeriod: null,
  managedCostLimitMicroUsd: null,
  ownKeyCostLimitMicroUsd: null,
};

const WORKSPACE_ROW: EntitlementsData = {
  planLabel: "team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 100,
    dynamicRunsPerPeriod: 10,
    managedCostLimitMicroUsd: 5_000_000,
    ownKeyCostLimitMicroUsd: 2_000_000,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
};

const DEFAULT: EntitlementsData = {
  planLabel: "starter",
  keyMode: "own",
  limits: {
    diffRunsPerPeriod: 5,
    dynamicRunsPerPeriod: 0,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  periodStart: "2026-09-01T00:00:00.000Z",
  suspended: true,
  suspensionCode: "payment_overdue",
};

describe("resolving the entitlements of a workspace", () => {
  // #271-T01
  it("is unlimited when the workspace has no row and there is no default", () => {
    expect(resolveEntitlements(undefined, undefined)).toEqual({
      kind: "unlimited",
    });
  });

  // #271-T02
  it("applies the default, and says so, when the workspace has no row", () => {
    expect(resolveEntitlements(undefined, DEFAULT)).toEqual({
      kind: "limited",
      source: "default",
      ...DEFAULT,
    });
  });

  // #271-T03
  it("lets the row of the workspace win entirely over the default, without merging fields", () => {
    const row: EntitlementsData = { ...WORKSPACE_ROW, limits: NO_LIMITS };

    expect(resolveEntitlements(row, DEFAULT)).toEqual({
      kind: "limited",
      source: "workspace",
      ...row,
    });
  });

  it("reports a row without any limit as limited with null limits, not as unlimited", () => {
    const row: EntitlementsData = {
      ...WORKSPACE_ROW,
      keyMode: "own",
      limits: NO_LIMITS,
    };

    expect(resolveEntitlements(row, undefined)).toMatchObject({
      kind: "limited",
      source: "workspace",
      limits: NO_LIMITS,
    });
  });

  // #271-T09
  it("reflects suspended and a cleared suspension code", () => {
    const suspended = {
      ...WORKSPACE_ROW,
      suspended: true,
      suspensionCode: "x",
    };
    const cleared = {
      ...WORKSPACE_ROW,
      suspended: false,
      suspensionCode: null,
    };

    expect(resolveEntitlements(suspended, undefined)).toMatchObject({
      suspended: true,
      suspensionCode: "x",
    });
    expect(resolveEntitlements(cleared, undefined)).toMatchObject({
      suspended: false,
      suspensionCode: null,
    });
  });

  it("copies named fields only, so nothing else of a stored row reaches the answer", () => {
    // What the repository hands over carries who saved it and when (personal data); and a future column.
    const stored = {
      ...WORKSPACE_ROW,
      limits: { ...WORKSPACE_ROW.limits, futureLimit: 7 },
      updatedBy: "user-1",
      updatedAt: "2026-10-14T12:00:00.000Z",
      futureColumn: true,
    } as EntitlementsData;

    const resolved = resolveEntitlements(stored, undefined);

    expect(resolved).toEqual({
      kind: "limited",
      source: "workspace",
      ...WORKSPACE_ROW,
    });
    expect(Object.keys(resolved).sort()).toEqual([
      "keyMode",
      "kind",
      "limits",
      "periodStart",
      "planLabel",
      "source",
      "suspended",
      "suspensionCode",
    ]);
  });

  it("does not hand out the limits object of the stored row", () => {
    const resolved = resolveEntitlements(WORKSPACE_ROW, undefined);

    expect(resolved.kind === "limited" && resolved.limits).not.toBe(
      WORKSPACE_ROW.limits,
    );
  });
});

describe("resolving entitlements that could not be read", () => {
  // #271-T10
  it("fails closed: an unreadable row of the workspace is invalid, never unlimited, and wins over a good default", () => {
    expect(resolveEntitlements(INVALID_ENTITLEMENTS, DEFAULT)).toEqual({
      kind: "invalid",
      code: "entitlements_invalid",
      source: "workspace",
    });
  });

  // #271-T10
  it("fails closed: an unreadable default is invalid for a workspace without a row", () => {
    expect(resolveEntitlements(undefined, INVALID_ENTITLEMENTS)).toEqual({
      kind: "invalid",
      code: "entitlements_invalid",
      source: "default",
    });
  });

  it("lets a good row of the workspace win over an unreadable default", () => {
    expect(
      resolveEntitlements(WORKSPACE_ROW, INVALID_ENTITLEMENTS),
    ).toMatchObject({ kind: "limited", source: "workspace" });
  });
});

const ENTRY_A = { id: "mce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const ENTRY_B = { id: "mce_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
const UNKNOWN_ID = "mce_00000000000000000000000000000000";

describe("the model access of a workspace (#428)", () => {
  // #428-T04
  it("lets the row win entirely, the model access included", () => {
    const row: EntitlementsData = {
      ...WORKSPACE_ROW,
      modelAccess: { catalogEntries: [ENTRY_A.id] },
    };
    const withList: EntitlementsData = {
      ...DEFAULT,
      modelAccess: { catalogEntries: [ENTRY_B.id] },
    };

    expect(resolveEntitlements(row, withList)).toMatchObject({
      source: "workspace",
      modelAccess: { catalogEntries: [ENTRY_A.id] },
    });
    // A row that states nothing about it does not inherit the list of the default.
    const resolved = resolveEntitlements(WORKSPACE_ROW, withList);
    expect(entryAllowed(resolved, ENTRY_B)).toBe(true);
    expect(entryAllowed(resolved, ENTRY_A)).toBe(true);
    expect(
      entryAllowed(
        resolveEntitlements(
          { ...WORKSPACE_ROW, modelAccess: { catalogEntries: [] } },
          undefined,
        ),
        ENTRY_B,
      ),
    ).toBe(false);
  });

  // #428-T04
  it("applies the model access of the default to a workspace without a row", () => {
    const withList: EntitlementsData = {
      ...DEFAULT,
      modelAccess: { catalogEntries: [ENTRY_B.id] },
    };

    const resolved = resolveEntitlements(undefined, withList);

    expect(resolved).toMatchObject({
      source: "default",
      modelAccess: { catalogEntries: [ENTRY_B.id] },
    });
    expect(entryAllowed(resolved, ENTRY_B)).toBe(true);
    expect(entryAllowed(resolved, ENTRY_A)).toBe(false);
  });

  describe("entryAllowed", () => {
    function limitedWith(
      modelAccess: EntitlementsData["modelAccess"],
      keyMode: EntitlementsData["keyMode"] = "managed",
    ) {
      return resolveEntitlements(
        {
          ...WORKSPACE_ROW,
          keyMode,
          limits: { ...WORKSPACE_ROW.limits, managedCostLimitMicroUsd: null },
          ...(modelAccess === undefined ? {} : { modelAccess }),
        },
        undefined,
      );
    }

    // #428-T07
    it("allows every entry for null, for an absent field and without any entitlements", () => {
      expect(
        entryAllowed(limitedWith({ catalogEntries: null }), ENTRY_A),
      ).toBe(true);
      expect(entryAllowed(limitedWith(undefined), ENTRY_A)).toBe(true);
      expect(entryAllowed({ kind: "unlimited" }, ENTRY_A)).toBe(true);
    });

    // #428-T07
    it("allows no entry for an empty list", () => {
      expect(entryAllowed(limitedWith({ catalogEntries: [] }), ENTRY_A)).toBe(
        false,
      );
    });

    // #428-T07
    it("allows the listed entries and not the unlisted ones", () => {
      const resolved = limitedWith({ catalogEntries: [ENTRY_A.id] });

      expect(entryAllowed(resolved, ENTRY_A)).toBe(true);
      expect(entryAllowed(resolved, ENTRY_B)).toBe(false);
    });

    // #428-T07
    it("keeps an id that matches no entry harmlessly in the list", () => {
      const resolved = limitedWith({ catalogEntries: [UNKNOWN_ID, ENTRY_B.id] });

      expect(entryAllowed(resolved, ENTRY_B)).toBe(true);
      expect(entryAllowed(resolved, ENTRY_A)).toBe(false);
      expect(entryAllowed(resolved, { id: UNKNOWN_ID })).toBe(true);
    });

    // #428-T07
    it("allows nothing when the entitlements cannot be read: damaged data does not grant a model", () => {
      expect(
        entryAllowed(
          resolveEntitlements(INVALID_ENTITLEMENTS, undefined),
          ENTRY_A,
        ),
      ).toBe(false);
    });

    // #428-T10
    it("reads the list whatever the key mode: that the own key ignores it is the decision of the caller", () => {
      expect(
        entryAllowed(
          limitedWith({ catalogEntries: [ENTRY_A.id] }, "own"),
          ENTRY_B,
        ),
      ).toBe(false);
    });
  });
});
