// SPDX-License-Identifier: Apache-2.0

"use client";
// The navigation between the sections of the portal, on the shadcn Sidebar primitives in a static
// column: it sits inside the admin frame (below the app header), not as the fixed full-height
// sidebar of the workspace, so it lines up with the centered admin content. `SectionLinks` takes the
// path as a value; `AdminNav` reads it from the router, which can wait for the request, so the frame
// shows the links without a current section meanwhile. The admin check lives in the admin layout.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, Suspense } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { ADMIN_NAV_GROUPS, isCurrentSection } from "./nav-items.ts";

export function SectionLinks({ pathname }: { pathname: string | null }) {
  return (
    <SidebarContent>
      {ADMIN_NAV_GROUPS.map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 ? <SidebarSeparator /> : null}
          <SidebarGroup>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const current = isCurrentSection(pathname, item);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={current}>
                        <Link
                          href={item.href}
                          aria-current={current ? "page" : undefined}
                        >
                          {item.label}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Fragment>
      ))}
    </SidebarContent>
  );
}

function CurrentSectionLinks() {
  return <SectionLinks pathname={usePathname()} />;
}

export function AdminNav() {
  return (
    <Sidebar
      collapsible="none"
      className="w-full md:w-64 md:border-r md:border-sidebar-border"
    >
      <nav aria-label="Admin" className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<SectionLinks pathname={null} />}>
          <CurrentSectionLinks />
        </Suspense>
      </nav>
    </Sidebar>
  );
}
