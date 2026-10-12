// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the small application wrappers of the kit (PageHeader, StatusRegion, DescriptionList,
// DangerZone) and the three legacy wrappers (`src/ui/*`) that now render them with unchanged props.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { Button as LegacyButton } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { PageHeader as LegacyPageHeader } from "@/ui/page-header";

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

describe("the legacy wrappers", () => {
  it("keeps the Button variant names and the type=button default", () => {
    render(<LegacyButton variant="destructive">Delete</LegacyButton>);

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.getAttribute("data-variant")).toBe("destructive");
    expect(button.getAttribute("type")).toBe("button");
  });

  it("renders the PageHeader through the kit", () => {
    render(<LegacyPageHeader title="Members" description="People here." />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Members" }),
    ).toBeTruthy();
    expect(screen.getByText("People here.")).toBeTruthy();
  });

  it("renders the EmptyState as a heading, a sentence and an action", () => {
    render(
      <EmptyState
        title="No invitations"
        action={<button type="button">Invite</button>}
      >
        Nobody has been invited yet.
      </EmptyState>,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "No invitations" }),
    ).toBeTruthy();
    expect(screen.getByText("Nobody has been invited yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
  });
});
