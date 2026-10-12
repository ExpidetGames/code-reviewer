// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins down the workspace switcher in the header: the workspace of the address as its label, every
// workspace of the person, the waiting invitations and the way to create one (multi-tenant only).
// Only names and slugs are passed in; a name is shown as text, never as markup.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/w/acme/projects" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { WorkspaceSwitcher } from "./workspace-switcher.tsx";

afterEach(() => {
  cleanup();
  navigation.pathname = "/w/acme/projects";
});

const workspaces = [
  { slug: "acme", name: "Acme" },
  { slug: "team-a", name: "Team A <i>" },
];

describe("the workspace switcher", () => {
  // #168-T04
  it("names the workspace of the address and lists the workspaces, the invitations and the create entry", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        workspaces={workspaces}
        canCreate
        pendingInvitations={2}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Workspace/ });
    expect(trigger.textContent).toContain("Acme");
    await user.click(trigger);

    const list = screen.getByRole("group", { name: "Your workspaces" });
    expect(
      within(list)
        .getAllByRole("menuitem")
        .map((entry) => entry.getAttribute("href")),
    ).toEqual(["/w/acme/projects", "/w/team-a/projects"]);
    expect(within(list).getByText("Team A <i>")).toBeTruthy();
    expect(document.querySelector("i")).toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Invitations (2)" })
        .getAttribute("href"),
    ).toBe("/invitations");
    expect(
      screen
        .getByRole("menuitem", { name: "Create a workspace" })
        .getAttribute("href"),
    ).toBe("/workspaces/new");
  });

  it("offers no creation on a single-tenant instance and shows the waiting invitations", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        workspaces={workspaces}
        canCreate={false}
        pendingInvitations={2}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Workspace/ }));

    expect(
      screen.queryByRole("menuitem", { name: "Create a workspace" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Invitations (2)" })
        .getAttribute("href"),
    ).toBe("/invitations");
  });

  it("follows the address: the other workspace is named when the page is in it", () => {
    navigation.pathname = "/w/team-a/runs/42";
    render(
      <WorkspaceSwitcher
        workspaces={workspaces}
        canCreate
        pendingInvitations={0}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Workspace/ }).textContent,
    ).toContain("Team A");
  });

  // CR-36-T02
  it("closes with Escape and puts the focus back on the trigger", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        workspaces={workspaces}
        canCreate
        pendingInvitations={0}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Workspace/ });
    await user.click(trigger);
    expect(screen.getByRole("group", { name: "Your workspaces" })).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("group", { name: "Your workspaces" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows nothing for an account with nothing to switch to", () => {
    const { container } = render(
      <WorkspaceSwitcher
        workspaces={[]}
        canCreate={false}
        pendingInvitations={0}
      />,
    );

    expect(container.textContent).toBe("");
  });
});
