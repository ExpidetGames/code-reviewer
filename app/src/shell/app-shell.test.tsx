// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the frame around every signed in page: the sidebar with its two groups of workspace
// places, the current one marked, the brand link, the skip link and the user menu slot. The narrow
// screen drawer is a journey (e2e/app/navigation.e2e.ts); whether it looks right is checked by eye.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/w/acme/runs" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AppShell } from "./app-shell.tsx";

// jsdom cannot navigate; a click on a link would only print a "not implemented" notice.
const keepPageInPlace = (event: Event) => event.preventDefault();
beforeEach(() => document.addEventListener("click", keepPageInPlace));

// The shim of the setup file (matchMedia always "desktop"); a narrow-screen test replaces it and
// this puts it back.
const desktopMatchMedia = window.matchMedia;
afterEach(() => {
  document.removeEventListener("click", keepPageInPlace);
  window.matchMedia = desktopMatchMedia;
  cleanup();
  navigation.pathname = "/w/acme/runs";
});

function renderShell() {
  return render(
    <AppShell userMenu={<span>user menu</span>}>
      <h1>Page content</h1>
    </AppShell>,
  );
}

function narrowScreen() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function mainNavigation() {
  return screen.getByRole("navigation", { name: "Main" });
}

describe("the sidebar", () => {
  // #168-T01
  it("shows the workspace places in two groups, separated, and marks only the current page", () => {
    renderShell();

    const nav = mainNavigation();
    const groups = nav.querySelectorAll('[data-slot="sidebar-group"]');

    expect(groups).toHaveLength(2);
    expect(
      Array.from(groups[0].querySelectorAll("a")).map((link) => [
        link.textContent,
        link.getAttribute("href"),
        link.getAttribute("aria-current"),
      ]),
    ).toEqual([
      ["Projects", "/w/acme/projects", null],
      ["Runs", "/w/acme/runs", "page"],
    ]);
    expect(
      Array.from(groups[1].querySelectorAll("a")).map(
        (link) => link.textContent,
      ),
    ).toEqual(["Connections", "Members", "Settings"]);
    expect(
      nav.querySelectorAll('[data-slot="sidebar-separator"]'),
    ).toHaveLength(1);
  });

  it("keeps a place marked while a page below it is open", () => {
    navigation.pathname = "/w/acme/runs/42";
    renderShell();

    expect(
      screen.getByRole("link", { name: "Runs" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "Projects" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks nothing on a page that is not one of the places, but still shows the places", () => {
    navigation.pathname = "/w/acme/runs-archive";
    renderShell();

    expect(mainNavigation()).toBeTruthy();
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  // #101-WM-03
  it("shows the places of the workspace in the address and of no other, so switching changes every link", () => {
    navigation.pathname = "/w/other-team/runs";
    renderShell();

    expect(
      within(mainNavigation())
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/w/other-team/projects",
      "/w/other-team/runs",
      "/w/other-team/connections",
      "/w/other-team/members",
      "/w/other-team/settings",
    ]);
  });

  // #101-WM-01
  it.each(["/no-access", "/workspaces/new", "/invitations", "/"])(
    "has no sidebar on %s, which is outside any workspace",
    (path) => {
      navigation.pathname = path;
      renderShell();

      expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    },
  );
});

describe("the frame", () => {
  it("sends the brand link to the start page, which opens the first workspace of the person", () => {
    renderShell();

    expect(
      screen.getByRole("link", { name: "Code Reviewer" }).getAttribute("href"),
    ).toBe("/");
  });

  it("puts the content in the main landmark and offers a way to skip the navigation", () => {
    renderShell();

    const main = screen.getByRole("main");
    expect(
      within(main).getByRole("heading", { name: "Page content" }),
    ).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe(`#${main.id}`);
  });

  it("shows the workspace switcher and the user menu it is given in the header, and a way to open the sidebar", () => {
    render(
      <AppShell
        userMenu={<span>user menu</span>}
        workspaceSwitcher={<span>workspace switcher</span>}
      >
        <h1>Page content</h1>
      </AppShell>,
    );

    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("user menu")).toBeTruthy();
    expect(within(banner).getByText("workspace switcher")).toBeTruthy();
    expect(
      within(banner).getByRole("button", { name: "Toggle Sidebar" }),
    ).toBeTruthy();
  });
});

describe("the drawer on a narrow screen", () => {
  // CR-36-T07, #168-T01
  it("opens with the trigger and closes when the page changes without a link, such as back and forward", async () => {
    const user = userEvent.setup();
    narrowScreen();
    const { rerender } = renderShell();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();

    navigation.pathname = "/w/acme/projects";
    rerender(
      <AppShell userMenu={<span>user menu</span>}>
        <h1>Page content</h1>
      </AppShell>,
    );

    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });
});
