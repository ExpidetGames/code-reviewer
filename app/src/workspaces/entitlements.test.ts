// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  INVALID_ENTITLEMENTS,
  resolveEntitlements,
  type EntitlementsData,
} from "./entitlements.ts";

const NO_LIMITS = {
  diffRunsPerPeriod: null,
  dynamicRunsPerPeriod: null,
  managedCostLimitMicroUsd: null,
};

const WORKSPACE_ROW: EntitlementsData = {
  planLabel: "team",
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 100,
    dynamicRunsPerPeriod: 10,
    managedCostLimitMicroUsd: 5_000_000,
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
