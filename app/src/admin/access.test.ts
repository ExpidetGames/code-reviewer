// SPDX-License-Identifier: Apache-2.0

// Who counts as the instance admin for the portal and the instance-wide data routes: the admin flag
// decides, whatever else is the matter with the account (an address still to verify, no workspace), and a
// person the allow list turned away is not signed in as far as the app is concerned.
import { describe, expect, it } from "vitest";
import { sessionUser } from "../test-support/session-lookup.ts";
import { adminAccessOf } from "./access.ts";

const ADMIN = sessionUser("root", { isInstanceAdmin: true });
const OWNER = sessionUser("owner");

describe("the admin access of a session", () => {
  it("is the admin for the instance admin, also while the address is unverified or there is no workspace", () => {
    for (const kind of ["user", "unverified", "no_workspace"] as const)
      expect(adminAccessOf({ kind, user: ADMIN }), kind).toEqual({
        kind: "admin",
        user: ADMIN,
      });
  });

  it("is not the admin for anybody else, whatever their workspace role, verification or workspace", () => {
    for (const kind of ["user", "unverified", "no_workspace"] as const)
      expect(adminAccessOf({ kind, user: OWNER }), kind).toEqual({
        kind: "not_admin",
      });
  });

  it("is anonymous without a session", () => {
    expect(adminAccessOf({ kind: "none" })).toEqual({ kind: "anonymous" });
  });
});
