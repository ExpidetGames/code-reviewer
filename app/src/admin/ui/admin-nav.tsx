// SPDX-License-Identifier: Apache-2.0

"use client";
// The navigation between the sections of the portal, on the shadcn Sidebar: the same component the
// workspace uses, so on a narrow screen it becomes the Sheet drawer (the admin frame gives it its
// own SidebarProvider and a trigger). On a wide screen its container is `absolute` inside that
// provider instead of the primitive's `fixed` full-height one, so it lines up with the centered
// admin content rather than the viewport. `SectionLinks` takes the path as a value; `AdminNav` reads
// it from the router, which can wait for the request, so the frame shows the links without a current
// section meanwhile. The admin check lives in the admin layout, before any of this renders.
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
import { SIDEBAR_LINK_CLASS } from "@/shell/nav-items.ts";
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
              <SidebarMenu className="m-0 list-none p-0">
                {group.items.map((item) => {
                  const current = isCurrentSection(pathname, item);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={current}>
                        <Link
                          href={item.href}
                          aria-current={current ? "page" : undefined}
                          className={SIDEBAR_LINK_CLASS}
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
      className="w-full md:absolute md:h-full md:w-64 md:border-r md:border-sidebar-border"
      // `md:absolute` overrides the primitive's `fixed` at md and up, so the container sits in the
      // `relative` admin provider and its 16rem gap lines up with the centered content.
    >
      <nav aria-label="Admin" className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<SectionLinks pathname={null} />}>
          <CurrentSectionLinks />
        </Suspense>
      </nav>
    </Sidebar>
  );
}
