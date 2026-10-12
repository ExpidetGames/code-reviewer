// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the user menu in the header: who is signed in, the way to sign out, the color theme and
// the admin portal for the instance admin only, and that the menu works from the keyboard. The name
// and avatar come from the GitHub profile, so they are shown as plain text and a missing or unusable
// avatar never leaves a broken image.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMenu } from "./user-menu.tsx";
import type { ShellUser } from "./user-display.ts";

afterEach(cleanup);

const ada: ShellUser = {
  name: "Ada Lovelace",
  login: "ada",
  avatarUrl: "https://avatars.example.test/u/1",
};

function renderMenu(
  user: ShellUser,
  signOut: () => Promise<void> = async () => {},
) {
  return render(<UserMenu user={user} signOutAction={signOut} />);
}

function openMenu() {
  return userEvent
    .setup()
    .click(screen.getByRole("button", { name: /Ada Lovelace/ }));
}

describe("the way to the admin portal", () => {
  // #168-T03
  it("is offered to the instance admin and to nobody else", async () => {
    const user = userEvent.setup();
    const admin = renderMenu({ ...ada, isInstanceAdmin: true });
    await user.click(screen.getByRole("button", { name: /Ada Lovelace/ }));
    const entry = screen.getByRole("menuitem", { name: "Admin" });
    expect(entry.getAttribute("href")).toBe("/admin");
    admin.unmount();

    renderMenu(ada);
    await user.click(screen.getByRole("button", { name: /Ada Lovelace/ }));

    expect(screen.queryByRole("menuitem", { name: "Admin" })).toBeNull();
  });
});

describe("opening the user menu", () => {
  // CR-36-T02
  it("shows the person and the sign out entry after the button is pressed", async () => {
    const user = userEvent.setup();
    renderMenu(ada);
    const button = screen.getByRole("button", { name: /Ada Lovelace/ });
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();

    await user.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(menu).getByText("@ada")).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: "Sign out" }),
    ).toBeTruthy();
  });

  // CR-36-T02
  it("opens from the keyboard and reaches the entries with the arrow keys", async () => {
    const user = userEvent.setup();
    renderMenu({ ...ada, isInstanceAdmin: true });

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Ada Lovelace/ }),
    );
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Account" }),
    );
    await user.keyboard("{ArrowDown}");

    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Admin" }),
    );
  });

  // #102-GH-23
  it("offers the account page to everybody who is signed in", async () => {
    const user = userEvent.setup();
    renderMenu(ada);

    await user.click(screen.getByRole("button", { name: /Ada Lovelace/ }));

    expect(
      screen.getByRole("menuitem", { name: "Account" }).getAttribute("href"),
    ).toBe("/account");
  });

  // CR-36-T02
  it("closes with Escape and puts the focus back on the button", async () => {
    const user = userEvent.setup();
    renderMenu(ada);
    const button = screen.getByRole("button", { name: /Ada Lovelace/ });
    await user.click(button);
    screen.getByRole("menuitem", { name: "Sign out" }).focus();

    await user.keyboard("{Escape}");

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a click outside it", async () => {
    const user = userEvent.setup();
    renderMenu(ada);
    const button = screen.getByRole("button", { name: /Ada Lovelace/ });
    await user.click(button);

    fireEvent.pointerDown(document.body);

    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("runs the sign out action when the entry is pressed", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn(async () => {});
    renderMenu(ada, signOut);
    await user.click(screen.getByRole("button", { name: /Ada Lovelace/ }));

    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("offers the color theme choice with the current one checked", async () => {
    renderMenu(ada);
    await openMenu();

    expect(
      screen
        .getAllByRole("menuitemradio")
        .map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    ).toEqual([
      ["System", "true"],
      ["Light", "false"],
      ["Dark", "false"],
    ]);
  });
});

describe("a person without a display name or avatar", () => {
  // CR-36-T05
  it("shows the login instead of the name and initials instead of a picture", async () => {
    const user = userEvent.setup();
    renderMenu({ name: "", login: "octocat", avatarUrl: null });

    const button = screen.getByRole("button", { name: "octocat" });
    expect(button.querySelector("img")).toBeNull();
    expect(button.textContent).toContain("O");
    await user.click(button);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  // CR-36-T05
  it("falls back to initials when the avatar cannot be loaded", () => {
    renderMenu(ada);
    const image = document.querySelector("img");
    expect(image).not.toBeNull();

    fireEvent.error(image!);

    expect(document.querySelector("img")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Ada Lovelace/ }).textContent,
    ).toContain("AL");
  });

  // CR-36-T05
  it("falls back to initials when the avatar already failed before the page became interactive", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true,
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      0,
    );

    renderMenu(ada);

    expect(document.querySelector("img")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Ada Lovelace/ }).textContent,
    ).toContain("AL");
  });

  it("does not load an avatar that is not an https address", () => {
    renderMenu({ ...ada, avatarUrl: "javascript:alert(1)" });

    expect(document.querySelector("img")).toBeNull();
  });
});

describe("a name that contains HTML", () => {
  // CR-36-T06
  it("shows it as text and does not create any element from it", async () => {
    const user = userEvent.setup();
    const hostile = "<img src=x onerror=alert(1)>";
    renderMenu({ name: hostile, login: "mallory", avatarUrl: null });

    await user.click(screen.getByRole("button", { name: hostile }));

    expect(screen.getAllByText(hostile).length).toBeGreaterThan(0);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("<img");
  });
});
