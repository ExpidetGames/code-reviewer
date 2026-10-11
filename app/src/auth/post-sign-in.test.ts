// SPDX-License-Identifier: Apache-2.0

// Pins down where the login form sends a person after a sign in: the page that says what is missing, or
// the start page.
import { describe, expect, it } from "vitest";
import type { AccessGates } from "./access-gates.ts";
import { pathAfterPasswordSignIn } from "./post-sign-in.ts";

function gates(mail: boolean, workspace: boolean): AccessGates {
  return {
    verificationRequired: () => Promise.resolve(mail),
    hasWorkspace: () => Promise.resolve(workspace),
    workspaceRole: () => Promise.resolve(workspace ? "member" : null),
  };
}
const PERSON = { id: "u", emailVerified: true, isInstanceAdmin: false };

describe("the page after a sign in with email and password", () => {
  // #99-SR-21
  it("is the start page for somebody who may use the app", async () => {
    expect(await pathAfterPasswordSignIn(PERSON, gates(true, true))).toBe("/");
  });

  // #99-SR-24
  it("is the verification page for an unverified address while the instance can send mail, the admin included", async () => {
    const unverified = { ...PERSON, emailVerified: false };

    expect(await pathAfterPasswordSignIn(unverified, gates(true, true))).toBe(
      "/verify-email",
    );
    expect(
      await pathAfterPasswordSignIn(
        { ...unverified, isInstanceAdmin: true },
        gates(true, false),
      ),
    ).toBe("/verify-email");
  });

  // #99-SR-08
  it("is the start page for an unverified address when the instance cannot send mail", async () => {
    expect(
      await pathAfterPasswordSignIn(
        { ...PERSON, emailVerified: false },
        gates(false, true),
      ),
    ).toBe("/");
  });

  // #99-SR-21
  it("is the page that asks for an invitation for somebody without a workspace, never for the admin", async () => {
    expect(await pathAfterPasswordSignIn(PERSON, gates(false, false))).toBe(
      "/no-access",
    );
    expect(
      await pathAfterPasswordSignIn(
        { ...PERSON, isInstanceAdmin: true },
        gates(false, false),
      ),
    ).toBe("/");
  });
});
