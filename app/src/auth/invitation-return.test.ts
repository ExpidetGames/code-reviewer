// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that only a link token is ever carried through the sign-in, and that it leads to the page of the
// invitation and nowhere else.
import { describe, expect, it } from "vitest";
import {
  invitationReturnPath,
  landingWithInvitation,
  pathCarrying,
} from "./invitation-return.ts";

const TOKEN = "A".repeat(43);

describe("carrying an invitation through the sign-in", () => {
  it("leads to the page of the invitation for a token", () => {
    expect(invitationReturnPath(TOKEN)).toBe(`/invitation?token=${TOKEN}`);
    expect(landingWithInvitation("/", TOKEN)).toBe(
      `/invitation?token=${TOKEN}`,
    );
    expect(landingWithInvitation("/no-access", TOKEN)).toBe(
      `/invitation?token=${TOKEN}`,
    );
  });

  // #101-SEC-REDIRECT
  it.each([
    "https://evil.example/",
    "//evil.example",
    "/admin",
    "../../x",
    `${TOKEN}&next=//evil`,
    `${TOKEN}/../..`,
    "",
    "short",
    42,
    null,
    undefined,
    ["a"],
  ])("carries nothing for %j and lands where the sign-in would", (value) => {
    expect(invitationReturnPath(value)).toBeNull();
    expect(landingWithInvitation("/", value)).toBe("/");
    expect(pathCarrying("/login", value)).toBe("/login");
  });

  it("keeps the person on the page that asks for the verification first", () => {
    expect(landingWithInvitation("/verify-email", TOKEN)).toBe("/verify-email");
  });

  it("puts the token on the login and sign-up addresses, with other parameters", () => {
    expect(pathCarrying("/sign-up", TOKEN)).toBe(
      `/sign-up?invitation=${TOKEN}`,
    );
    expect(
      pathCarrying("/login", TOKEN, { error: "invalid_credentials" }),
    ).toBe(`/login?error=invalid_credentials&invitation=${TOKEN}`);
  });
});
