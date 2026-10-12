// SPDX-License-Identifier: Apache-2.0

// The decision "may this request act in this workspace": a member with the right role does, everybody else
// is told no in a way that does not say whether the workspace exists.
import { describe, expect, it } from "vitest";
import type { Membership } from "../db/repositories/workspaces-repository.ts";
import type { SessionLookup } from "../auth/session-user.ts";
import { resolveWorkspaceAccess } from "./access.ts";
import { WORKSPACE_ACTIONS } from "./permissions.ts";

type User = Extract<SessionLookup, { kind: "user" }>["user"];

const USER: User = {
  id: "u1",
  name: "Person",
  email: "person@example.test",
  isInstanceAdmin: false,
  githubLogin: null,
  githubId: null,
  image: null,
  orgCheckedAt: null,
  orgCheckedFor: null,
};
const WORKSPACE = {
  id: "w1",
  name: "Acme",
  slug: "acme",
  createdBy: null,
  createdAt: "2026-10-12T00:00:00.000Z",
};
const memberships: Record<string, Membership["role"]> = { acme: "member" };

const find = (userId: string, slug: string) =>
  Promise.resolve(
    userId === "u1" && memberships[slug] !== undefined
      ? { workspace: { ...WORKSPACE, slug }, role: memberships[slug] }
      : undefined,
  );

const signedIn: SessionLookup = { kind: "user", user: USER };

describe("the access to a workspace", () => {
  // #101-WM-06
  it("is given to a member, with the workspace and the role", async () => {
    const result = await resolveWorkspaceAccess({
      lookup: signedIn,
      slug: "acme",
      findMembership: find,
    });

    expect(result).toEqual({
      kind: "ok",
      access: { user: USER, workspace: WORKSPACE, role: "member" },
    });
  });

  // #101-WM-06
  it.each(["other", "ACME", "", "a b", "../acme", 7, null, undefined])(
    "is not found for the workspace %j that the person does not belong to",
    async (slug) => {
      const result = await resolveWorkspaceAccess({
        lookup: signedIn,
        slug,
        findMembership: find,
      });

      expect(result).toEqual({ kind: "not_found" });
    },
  );

  // #101-WM-06
  it("is not found for a person who is not a member, also an instance admin", async () => {
    const admin: SessionLookup = {
      kind: "user",
      user: { ...USER, id: "admin", isInstanceAdmin: true },
    };

    expect(
      await resolveWorkspaceAccess({
        lookup: admin,
        slug: "acme",
        findMembership: find,
      }),
    ).toEqual({ kind: "not_found" });
  });

  // #101-WM-08
  it("is forbidden for a member whose role does not allow the action, and says which role they have", async () => {
    const result = await resolveWorkspaceAccess({
      lookup: signedIn,
      slug: "acme",
      findMembership: find,
      action: "manage_projects",
    });

    expect(result).toEqual({ kind: "forbidden", role: "member" });
  });

  it("asks the role for every action there is", async () => {
    for (const action of WORKSPACE_ACTIONS) {
      const result = await resolveWorkspaceAccess({
        lookup: signedIn,
        slug: "acme",
        findMembership: find,
        action,
      });
      expect(["ok", "forbidden"]).toContain(result.kind);
    }
  });

  it("does not look anything up for a session that cannot use the app", async () => {
    const never = () => Promise.reject(new Error("must not be asked"));
    const cases: Array<[SessionLookup, string]> = [
      [{ kind: "none" }, "anonymous"],
      [{ kind: "denied", reason: "not_allowed" }, "anonymous"],
      [{ kind: "unverified", user: USER }, "unverified"],
      [{ kind: "no_workspace", user: USER }, "no_workspace"],
    ];

    for (const [lookup, kind] of cases)
      expect(
        await resolveWorkspaceAccess({
          lookup,
          slug: "acme",
          findMembership: never,
        }),
      ).toEqual({ kind });
  });
});
