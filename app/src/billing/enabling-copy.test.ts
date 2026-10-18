// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { enablingNotice } from "./enabling-copy.ts";

describe("the copy of the enabling step", () => {
  // #437-T09
  it("states that the Free plan is managed, that the own key needs an own plan, and the count of workspaces with a stored own key", () => {
    const notice = enablingNotice({ ownKeyWorkspaces: 3 }).join(" ");

    expect(notice).toContain("Free plan");
    expect(notice).toMatch(/managed/);
    expect(notice).toMatch(/own key[^.]*not used/i);
    expect(notice).toMatch(/\bown\b plan/);
    expect(notice).toContain("own_key_requires_plan");
    expect(notice).toMatch(/\b3 workspaces\b/);
  });

  // #437-T09
  it("says one workspace in the singular, and that none is affected when none holds an own key", () => {
    expect(enablingNotice({ ownKeyWorkspaces: 1 }).join(" ")).toMatch(
      /\b1 workspace\b(?!s)/,
    );
    const none = enablingNotice({ ownKeyWorkspaces: 0 }).join(" ");
    expect(none).toMatch(/no workspace/i);
    expect(none).toContain("Free plan");
  });

  // #438-N4
  it("says that a default entitlements setting of the operator is replaced and is not brought back by switching billing off", () => {
    for (const ownKeyWorkspaces of [0, 1, 3]) {
      const notice = enablingNotice({ ownKeyWorkspaces }).join(" ");

      expect(notice).toMatch(
        /default entitlements[^.]*(already|existing|set)[^.]*replaced/i,
      );
      expect(notice).toMatch(/not restored|is not brought back/i);
      expect(notice).toMatch(/switch(ing)? billing off/i);
      expect(notice).toMatch(/no default|unlimited/i);
    }
  });
});
