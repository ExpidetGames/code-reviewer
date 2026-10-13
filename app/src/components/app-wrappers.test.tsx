// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the small application wrappers of the kit: PageHeader, StatusRegion, DescriptionList and
// DangerZone.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthCard } from "./auth-card.tsx";
import { DescriptionList } from "./description-list.tsx";
import { DangerZone } from "./danger-zone.tsx";
import { PageHeader } from "./page-header.tsx";
import { StatusRegion } from "./status-region.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "./ui/breadcrumb.tsx";

afterEach(cleanup);

describe("the page header", () => {
  it("renders one h1, a breadcrumb slot, a description and the actions", () => {
    render(
      <PageHeader
        title="Projects"
        description="Repositories of this workspace."
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>acme</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        actions={<button type="button">Sync</button>}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeTruthy();
    expect(screen.getByText("Repositories of this workspace.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync" })).toBeTruthy();
  });
});

describe("the auth card", () => {
  it("renders one h1 from the title, its children, and merges the given class", () => {
    render(
      <AuthCard title="Sign in" className="custom-frame">
        <p>Form goes here.</p>
      </AuthCard>,
    );

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Sign in");
    expect(screen.getByText("Form goes here.")).toBeTruthy();
    const card = screen
      .getByText("Form goes here.")
      .closest('[data-slot="card"]');
    expect(card?.className).toContain("custom-frame");
    expect(card?.className).toContain("max-w-[34rem]");
  });
});

describe("the status region", () => {
  it("is a polite live region", () => {
    render(<StatusRegion>2 new repositories.</StatusRegion>);

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("2 new repositories.");
  });
});

describe("the description list", () => {
  it("pairs every term with its value", () => {
    render(
      <DescriptionList
        items={[
          { term: "Status", description: "Passed" },
          { term: "Duration", description: "12 s" },
        ]}
      />,
    );

    expect(screen.getByText("Status").tagName).toBe("DT");
    expect(screen.getByText("Passed").tagName).toBe("DD");
    expect(screen.getByText("Duration").tagName).toBe("DT");
    expect(screen.getByText("12 s").tagName).toBe("DD");
  });
});

describe("the danger zone", () => {
  it("confirms through an alert dialog before it runs the action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <DangerZone
        title="Remove the workspace key"
        description="Reviews stop working."
        actionLabel="Remove key"
        confirmTitle="Remove the key?"
        confirmDescription="This cannot be undone."
        confirmLabel="Remove"
        onConfirm={onConfirm}
      />,
    );
    const opener = screen.getByRole("button", { name: "Remove key" });

    // The title is the card's heading and gives the card its accessible name (one h2 per card).
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Remove the workspace key",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Remove the workspace key" }),
    ).toBeTruthy();

    await user.click(opener);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("This cannot be undone.");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(opener);
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
