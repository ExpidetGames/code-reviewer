// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { JOB_ERROR_CODES } from "../jobs/job-types.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import {
  DEFAULT_LLM_KEY_MODE,
  applyWorkspaceKeyMode,
  effectiveKeyMode,
} from "./effective-key-mode.ts";
import {
  ENTITLEMENTS_INVALID_CODE,
  type KeyMode,
  type ResolvedEntitlements,
} from "./entitlements.ts";

const limited = (
  keyMode: KeyMode,
  overrides: Partial<Extract<ResolvedEntitlements, { kind: "limited" }>> = {},
): Extract<ResolvedEntitlements, { kind: "limited" }> => ({
  kind: "limited",
  source: "workspace",
  planLabel: "plan",
  keyMode,
  limits: {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: 5_000_000,
    ownKeyCostLimitMicroUsd: 7_000_000,
  },
  periodStart: "2026-10-01T00:00:00.000Z",
  suspended: false,
  suspensionCode: null,
  ...overrides,
});
const UNLIMITED: ResolvedEntitlements = { kind: "unlimited" };
const INVALID: ResolvedEntitlements = {
  kind: "invalid",
  code: ENTITLEMENTS_INVALID_CODE,
  source: "workspace",
};

describe("the effective key mode", () => {
  // #496-T01
  it("is the entitlement while billing is off, whatever the workspace chose", () => {
    for (const choice of [undefined, "managed", "own"] as const) {
      expect(
        effectiveKeyMode({
          billingOn: false,
          workspaceChoice: choice,
          entitlements: limited("own"),
        }),
      ).toBe("own");
      expect(
        effectiveKeyMode({
          billingOn: false,
          workspaceChoice: choice,
          entitlements: limited("managed"),
        }),
      ).toBe("managed");
      expect(
        effectiveKeyMode({
          billingOn: false,
          workspaceChoice: choice,
          entitlements: UNLIMITED,
        }),
      ).toBe("own");
    }
  });

  // #496-T02
  it("is the choice of the workspace while billing is on, whatever the entitlement says", () => {
    for (const entitlements of [
      UNLIMITED,
      limited("own"),
      limited("managed"),
    ]) {
      expect(
        effectiveKeyMode({
          billingOn: true,
          workspaceChoice: "own",
          entitlements,
        }),
      ).toBe("own");
      expect(
        effectiveKeyMode({
          billingOn: true,
          workspaceChoice: "managed",
          entitlements,
        }),
      ).toBe("managed");
    }
  });

  // #496-T02
  it("is our models while billing is on and the workspace has not chosen", () => {
    expect(DEFAULT_LLM_KEY_MODE).toBe("managed");
    for (const entitlements of [UNLIMITED, limited("own")])
      expect(
        effectiveKeyMode({
          billingOn: true,
          workspaceChoice: undefined,
          entitlements,
        }),
      ).toBe("managed");
  });

  // #496-T08
  it("is unreadable for entitlements that cannot be read, with billing on or off", () => {
    for (const billingOn of [false, true])
      expect(
        effectiveKeyMode({
          billingOn,
          workspaceChoice: "own",
          entitlements: INVALID,
        }),
      ).toBe("unreadable");
  });
});

describe("the entitlements with the key mode that applies", () => {
  // #496-T08
  it("keeps everything but the key mode of limited entitlements", () => {
    const row = limited("own", {
      suspended: true,
      suspensionCode: "unpaid",
      modelAccess: { catalogEntries: ["entry-1"] },
    });

    const applied = applyWorkspaceKeyMode(row, {
      billingOn: true,
      workspaceChoice: "managed",
    });

    expect(applied).toEqual({ ...row, keyMode: "managed" });
    expect(row.keyMode).toBe("own");
  });

  // #496-T01
  it("leaves the entitlements as they are while billing is off", () => {
    const row = limited("own");
    expect(
      applyWorkspaceKeyMode(row, {
        billingOn: false,
        workspaceChoice: "managed",
      }),
    ).toBe(row);
    expect(
      applyWorkspaceKeyMode(UNLIMITED, {
        billingOn: false,
        workspaceChoice: "managed",
      }),
    ).toBe(UNLIMITED);
  });

  // #496-T02
  it("gives workspaces without entitlements a key mode and no limits while billing is on", () => {
    const applied = applyWorkspaceKeyMode(UNLIMITED, {
      billingOn: true,
      workspaceChoice: "managed",
    });

    expect(applied).toEqual({ kind: "unlimited", keyMode: "managed" });
    expect(keyModeForJob(applied)).toBe("managed");
    expect(
      keyModeForJob(
        applyWorkspaceKeyMode(UNLIMITED, {
          billingOn: true,
          workspaceChoice: undefined,
        }),
      ),
    ).toBe("managed");
  });

  // #496-T08
  it("never makes unreadable entitlements readable", () => {
    expect(
      applyWorkspaceKeyMode(INVALID, {
        billingOn: true,
        workspaceChoice: "own",
      }),
    ).toBe(INVALID);
  });
});

describe("the error codes of a job", () => {
  // #496-T10
  it("has no own_key_requires_plan", () => {
    expect(JOB_ERROR_CODES).not.toContain("own_key_requires_plan");
  });
});
