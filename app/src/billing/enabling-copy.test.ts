// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { enablingNotice } from "./enabling-copy.ts";
import { getProductIdentity } from "../product-identity/current.ts";

const PRODUCT = getProductIdentity();

describe("the copy of the enabling step", () => {
  // #504-T13
  it("says that every workspace is charged from a prepaid balance, that workspaces choose their key mode, and what a workspace with no balance can do", () => {
    const notice = enablingNotice(PRODUCT, {
      workspaces: 5,
      ownKeyWorkspaces: 2,
    }).join(" ");

    expect(notice).toMatch(/reviews of every workspace[^.]*charged/i);
    expect(notice).toMatch(/prepaid balance/i);
    expect(notice).toMatch(/choose[^.]*key mode/i);
    expect(notice).toMatch(/our models|your models|the default/i);
    expect(notice).toMatch(/no balance[^.]*cannot start a review/i);
    expect(notice).toMatch(/start credit/i);
    expect(notice).toMatch(/run quotas[^.]*not applied/i);
    expect(notice).toMatch(/operator API limits[^.]*stay/i);
  });

  // #504-T13
  it("states the number of workspaces and how many of them hold a stored own key", () => {
    const notice = enablingNotice(PRODUCT, {
      workspaces: 5,
      ownKeyWorkspaces: 2,
    }).join(" ");

    expect(notice).toMatch(/\b5 workspaces\b/);
    expect(notice).toMatch(/\b2 of them\b[^.]*stored own key/i);
  });

  // #504-T13
  it.each([
    [1, 0, /\b1 workspace\b(?!s)/, /none of them holds a stored own key/i],
    [1, 1, /\b1 workspace\b(?!s)/, /\b1 of them\b|it holds a stored own key/i],
    [0, 0, /\bno workspace\b/i, /./],
  ])(
    "says %i workspaces with %i own keys in good English",
    (workspaces, ownKeyWorkspaces, countText, keyText) => {
      const notice = enablingNotice(PRODUCT, {
        workspaces,
        ownKeyWorkspaces,
      }).join(" ");

      expect(notice).toMatch(countText);
      expect(notice).toMatch(keyText);
    },
  );

  // #504-T13
  it("uses no wording of the removed subscription design", () => {
    for (const facts of [
      { workspaces: 0, ownKeyWorkspaces: 0 },
      { workspaces: 3, ownKeyWorkspaces: 3 },
    ]) {
      const notice = enablingNotice(PRODUCT, facts).join(" ");

      expect(notice.toLowerCase()).not.toContain(["pad", "dle"].join(""));
      expect(notice).not.toMatch(/\bplans?\b|subscription|free plan/i);
    }
  });
});
