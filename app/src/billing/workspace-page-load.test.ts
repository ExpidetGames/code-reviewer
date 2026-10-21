// SPDX-License-Identifier: Apache-2.0

// #505: what the page file of the billing page asks for before it renders: nothing while billing is off (the page does not
// exist then), the data of the person's workspace while it is on, and what the payment page said on the way back.
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceBillingView } from "../workspace-billing/view.ts";
import { loadWorkspaceBillingPage, returnedOf } from "./workspace-page-load.ts";

const VIEW = { canManage: true } as WorkspaceBillingView;
const ACTOR = { workspaceId: "w1", userId: "u1", role: "owner" } as const;

describe("what the payment page said on the way back", () => {
  // #505-T03
  it.each([
    ["success", "success"],
    ["cancelled", "cancelled"],
    ["other", null],
    ["", null],
    [undefined, null],
    [["success", "cancelled"], null],
  ])("reads %j as %s", (value, expected) => {
    expect(returnedOf(value)).toBe(expected);
  });
});

describe("loading the billing page", () => {
  // #505-T11
  it("is not found while billing is off, and reads nothing of the workspace", async () => {
    const overview = vi.fn();

    const result = await loadWorkspaceBillingPage({
      isOn: () => Promise.resolve(false),
      service: { overview },
      actor: ACTOR,
      topup: undefined,
    });

    expect(result).toEqual({ kind: "not_found" });
    expect(overview).not.toHaveBeenCalled();
  });

  // #505-T01
  it("gives the view of the person's workspace and the return state while billing is on", async () => {
    const overview = vi.fn(() =>
      Promise.resolve({ ok: true as const, view: VIEW }),
    );

    const result = await loadWorkspaceBillingPage({
      isOn: () => Promise.resolve(true),
      service: { overview },
      actor: ACTOR,
      topup: "success",
    });

    expect(result).toEqual({ kind: "ok", view: VIEW, returned: "success" });
    expect(overview).toHaveBeenCalledWith(ACTOR);
  });

  // #505-T02
  it("is not found for a refused person", async () => {
    const result = await loadWorkspaceBillingPage({
      isOn: () => Promise.resolve(true),
      service: {
        overview: () =>
          Promise.resolve({ ok: false as const, error: "forbidden" as const }),
      },
      actor: ACTOR,
      topup: undefined,
    });

    expect(result).toEqual({ kind: "not_found" });
  });
});
