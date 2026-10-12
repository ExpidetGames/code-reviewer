// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the account page (#179): exactly two cards, Email and GitHub, each with one status badge and
// one line; the link panel renders as a normal card, not as a settings form.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountPageContent } from "./account-view.tsx";

afterEach(cleanup);

const BASE = {
  name: "Ada Lovelace",
  githubSignInAvailable: true,
  isInstanceAdmin: false,
  outcome: { ok: null, error: null },
} as const;

function cards() {
  return Array.from(document.querySelectorAll('[data-slot="card"]'));
}

describe("the account page", () => {
  // #179-T01
  it("shows exactly two cards, Email and GitHub", () => {
    render(
      <AccountPageContent
        {...BASE}
        account={{
          email: "ada@example.com",
          verified: true,
          placeholder: false,
          emailConflict: null,
          identity: null,
        }}
      />,
    );

    const found = cards();
    expect(found).toHaveLength(2);
    expect(
      found.map(
        (card) =>
          card.querySelector('[data-slot="card-title"]')?.textContent ?? null,
      ),
    ).toEqual(["Email", "GitHub"]);
  });

  // #179-T03
  it("renders the link panel as a normal card, not a settings form", () => {
    render(
      <AccountPageContent
        {...BASE}
        account={{
          email: "ada@example.com",
          verified: true,
          placeholder: false,
          emailConflict: null,
          identity: null,
        }}
      />,
    );

    expect(document.querySelector(".settings-form")).toBeNull();
    const github = screen.getByText("GitHub").closest('[data-slot="card"]');
    expect(github).not.toBeNull();
    expect(
      within(github as HTMLElement).getByRole("button", {
        name: "Link GitHub account",
      }),
    ).toBeTruthy();
  });

  it("keeps the conflict detail behind a disclosure instead of a paragraph", () => {
    render(
      <AccountPageContent
        {...BASE}
        account={{
          email: "imported@placeholder.local",
          verified: false,
          placeholder: true,
          emailConflict: "ada@example.com",
          identity: null,
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Why your GitHub address could not be used",
      }),
    ).toBeTruthy();
  });

  it("shows the merge explanation only for the instance admin", () => {
    const account = {
      email: "ada@example.com",
      verified: true,
      placeholder: false,
      emailConflict: null,
      identity: null,
    } as const;

    const { unmount } = render(
      <AccountPageContent {...BASE} account={account} />,
    );
    expect(
      screen.queryByRole("button", { name: "What merging does" }),
    ).toBeNull();
    unmount();

    render(<AccountPageContent {...BASE} isInstanceAdmin account={account} />);
    expect(
      screen.getByRole("button", { name: "What merging does" }),
    ).toBeTruthy();
  });

  it("hides the merge explanation while signing in with GitHub is not available", () => {
    render(
      <AccountPageContent
        {...BASE}
        isInstanceAdmin
        githubSignInAvailable={false}
        account={{
          email: "ada@example.com",
          verified: true,
          placeholder: false,
          emailConflict: null,
          identity: null,
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "What merging does" }),
    ).toBeNull();
  });
});
