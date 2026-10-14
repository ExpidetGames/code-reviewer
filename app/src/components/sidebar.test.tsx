// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom
// Pins the Sidebar primitive: it renders its items inside the shell and marks the active entry.
import { cleanup, render, screen } from "@testing-library/react";
import Link from "next/link";
import { afterEach, describe, expect, it } from "vitest";
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "./ui/sidebar.tsx";

afterEach(cleanup);

describe("the sidebar primitive", () => {
  it("renders its navigation and marks the active entry", () => {
    render(
      <SidebarProvider>
        <Sidebar aria-label="Workspace">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive>
                  <Link href="/w/acme/projects">Projects</Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>Page content</SidebarInset>
      </SidebarProvider>,
    );

    const link = screen.getByRole("link", { name: "Projects" });
    expect(link.getAttribute("href")).toBe("/w/acme/projects");
    expect(link.getAttribute("data-active")).toBe("true");
    expect(screen.getByText("Page content")).toBeTruthy();
  });
});
