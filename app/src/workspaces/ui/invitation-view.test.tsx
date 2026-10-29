// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the page of a valid invitation: it names the workspace and the invited address exactly once
// (both are untrusted text), offers one primary action, and never accepts anything by being opened
// (#171).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthCard } from "@/components/auth-card";
import { InvitationView } from "./invitation-view.tsx";
import { getProductIdentity } from "../../product-identity/current.ts";

afterEach(cleanup);

const base = {
  product: getProductIdentity(),
  token: "T".repeat(43),
  workspaceName: "Acme <script>",
  role: "member" as const,
  email: "invited@example.com",
  signOutAction: vi.fn(async () => undefined),
};

function renderInCard(props: Parameters<typeof InvitationView>[0]) {
  return render(
    <AuthCard product={getProductIdentity()} title="You have an invitation">
      <InvitationView {...props} />
    </AuthCard>,
  );
}

describe("the page of a valid invitation", () => {
  // #171-T02
  it("names the workspace and the address once and offers a single primary accept", () => {
    renderInCard({ ...base, signedInAs: base.email });

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "You have an invitation",
      }),
    ).toBeTruthy();
    // The workspace name is untrusted: it is text, never markup.
    expect(screen.getByText("Acme <script>")).toBeTruthy();
    expect(screen.getAllByText("invited@example.com")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /Accept invitation/ }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("points a signed out visitor at the sign-in and the sign-up with the invitation", () => {
    renderInCard({ ...base, signedInAs: null });

    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe(`/login?invitation=${encodeURIComponent(base.token)}`);
    expect(
      screen
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe(`/sign-up?invitation=${encodeURIComponent(base.token)}`);
  });

  // The mismatch branch used to repeat the invited address; it now says it in one sentence.
  it("tells a person signed in as another address what to do without repeating the address", () => {
    renderInCard({ ...base, signedInAs: "other@example.com" });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/different address/);
    expect(alert.textContent).not.toContain(base.email);
    expect(screen.getAllByText("invited@example.com")).toHaveLength(1);
  });
});
