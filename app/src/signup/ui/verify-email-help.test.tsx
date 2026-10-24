// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the page behind a verification link without a token: one line that says what to do, the
// form that asks for a new link, and the longer explanation behind a disclosure instead of in the
// page's text (#171).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyEmailHelp } from "./verify-email-help.tsx";

afterEach(cleanup);

const signOutAction = vi.fn(async () => undefined);

describe("the page that asks to confirm an address", () => {
  // #171-T01
  it("shows one line and the form for a new link, with the explanation behind a disclosure", () => {
    render(
      <VerifyEmailHelp
        email={null}
        isAdmin={false}
        signOutAction={signOutAction}
      />,
    );

    expect(
      screen.getByText(
        /Open the confirmation link in the email we sent you and enter the password you chose when you signed up\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("form", { name: "Request a new link" }),
    ).toBeTruthy();

    const trigger = screen.getByRole("button", {
      name: "How confirmation works",
    });
    const content = document.getElementById(
      trigger.getAttribute("aria-controls") ?? "",
    );
    expect(content?.hidden).toBe(true);
    expect(content?.textContent).toMatch(/A link works once and for 24 hours/);
    // The explanation is written exactly once, not repeated in the line above.
    expect(
      screen.getAllByText(/A link works once and for 24 hours/),
    ).toHaveLength(1);
  });

  // #171-T01
  it("keeps a way out of a signed in session, and links back to the sign-in without one", () => {
    const signedIn = render(
      <VerifyEmailHelp
        email="me@example.com"
        isAdmin={false}
        signOutAction={signOutAction}
      />,
    );
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Back to the sign-in" }),
    ).toBeNull();
    signedIn.unmount();

    render(
      <VerifyEmailHelp
        email={null}
        isAdmin={false}
        signOutAction={signOutAction}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: "Back to the sign-in" })
        .getAttribute("href"),
    ).toBe("/login");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  // #99-SR-24
  it("gives the instance admin one link to the portal", () => {
    render(
      <VerifyEmailHelp
        email="admin@example.com"
        isAdmin
        signOutAction={signOutAction}
      />,
    );

    expect(
      screen
        .getByRole("link", { name: "open the admin portal" })
        .getAttribute("href"),
    ).toBe("/admin");
  });
});
