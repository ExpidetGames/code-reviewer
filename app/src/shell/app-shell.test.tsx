// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the frame around every signed in page: the navigation with its three places and the
// current one marked, and on a narrow screen the menu button that opens and closes it. Whether it
// looks right is checked by eye (see the ticket); here only what a screen reader or keyboard can
// observe is checked.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/runs" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AppShell } from "./app-shell.tsx";

// jsdom cannot navigate; a click on a link would only print a "not implemented" notice.
const keepPageInPlace = (event: Event) => event.preventDefault();
beforeEach(() => document.addEventListener("click", keepPageInPlace));

afterEach(() => {
  document.removeEventListener("click", keepPageInPlace);
  cleanup();
  navigation.pathname = "/runs";
});

function renderShell() {
  return render(
    <AppShell userMenu={<span>user menu</span>}>
      <h1>Page content</h1>
    </AppShell>,
  );
}

describe("the navigation", () => {
  // CR-36-T01
  it("links Projects, Runs and Settings and marks only the current page", () => {
    renderShell();

    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual([
      "Projects",
      "Runs",
      "Settings",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/projects",
      "/runs",
      "/settings",
    ]);
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([
      null,
      "page",
      null,
    ]);
  });

  it("keeps a place marked while a page below it is open", () => {
    navigation.pathname = "/runs/42";
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

  it("marks nothing on a page that is not one of the three places", () => {
    navigation.pathname = "/runs-archive";
    renderShell();

    expect(document.querySelector("[aria-current]")).toBeNull();
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

  it("shows the user menu it is given in the header", () => {
    renderShell();

    expect(
      within(screen.getByRole("banner")).getByText("user menu"),
    ).toBeTruthy();
  });
});

describe("the menu on a narrow screen", () => {
  // CR-36-T07
  it("opens and closes the navigation with the menu button and keeps aria-expanded in step", async () => {
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "Menu" });
    const nav = screen.getByRole("navigation", { name: "Main" });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(nav.id);
    expect(nav.getAttribute("data-open")).toBe("false");

    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(nav.getAttribute("data-open")).toBe("true");

    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(nav.getAttribute("data-open")).toBe("false");
  });

  // CR-36-T07
  it("closes the navigation after a place is chosen", async () => {
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);

    await user.click(screen.getByRole("link", { name: "Settings" }));

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen
        .getByRole("navigation", { name: "Main" })
        .getAttribute("data-open"),
    ).toBe("false");
  });

  it("closes the open navigation with Escape and puts the focus back on the menu button", async () => {
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);
    await user.click(screen.getByRole("link", { name: "Projects" }));
    await user.click(button);
    screen.getByRole("link", { name: "Runs" }).focus();

    await user.keyboard("{Escape}");

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  // CR-36-T07
  it("closes the navigation when the page changes by any other way than a nav link, such as the brand link or back and forward", async () => {
    const user = userEvent.setup();
    const { rerender } = renderShell();
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    navigation.pathname = "/projects";
    rerender(
      <AppShell userMenu={<span>user menu</span>}>
        <h1>Page content</h1>
      </AppShell>,
    );

    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  // CR-36-T07
  it("closes the navigation when the brand link is chosen on the page it points to", async () => {
    const user = userEvent.setup();
    navigation.pathname = "/projects";
    renderShell();
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);

    await user.click(screen.getByRole("link", { name: "Code Reviewer" }));

    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  // CR-36-T07
  it("closes the navigation on a click outside it, also on the user menu", async () => {
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "Menu" });

    await user.click(button);
    fireEvent.pointerDown(
      screen.getByRole("heading", { name: "Page content" }),
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await user.click(button);
    fireEvent.pointerDown(screen.getByText("user menu"));
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open when the press lands on the navigation itself", async () => {
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);

    fireEvent.pointerDown(screen.getByRole("navigation", { name: "Main" }));

    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});
