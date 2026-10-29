// SPDX-License-Identifier: LicenseRef-Proprietary

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
import { Fragment, Suspense, useEffect, useRef } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { useCapabilities } from "@/capabilities/context";
import { Badge } from "@/components/ui/badge";
import { SIDEBAR_LINK_CLASS } from "@/shell/nav-items.ts";
import {
  adminNavGroupsFor,
  isCurrentSection,
  type AdminNavItem,
} from "./nav-items.ts";

/** The number of open billing review rows next to a label, and in words for a screen reader (#603). */
function ReviewCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <Badge variant="warning" aria-hidden="true" className="ml-auto">
        {count > 99 ? "99+" : count}
      </Badge>
      <span className="sr-only">, {count} open payment reviews</span>
    </>
  );
}

export function SectionLinks({
  pathname,
  reviewCount = 0,
}: {
  pathname: string | null;
  /** How many billing review rows are open (#603). */
  reviewCount?: number;
}) {
  const groups = adminNavGroupsFor(useCapabilities());
  return (
    <SidebarContent>
      {groups.map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 ? <SidebarSeparator /> : null}
          <SidebarGroup>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="m-0 list-none p-0">
                {group.items.map((item) => (
                  <AdminLink
                    key={item.href}
                    item={item}
                    pathname={pathname}
                    reviewCount={reviewCount}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Fragment>
      ))}
    </SidebarContent>
  );
}

function AdminLink({
  item,
  pathname,
  reviewCount,
}: {
  item: AdminNavItem;
  pathname: string | null;
  reviewCount: number;
}) {
  const { setOpenMobile } = useSidebar();
  const current = isCurrentSection(pathname, item);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={current}>
        <Link
          href={item.href}
          aria-current={current ? "page" : undefined}
          className={SIDEBAR_LINK_CLASS}
          onClick={() => setOpenMobile(false)}
        >
          {item.label}
          {item.showsReviewCount === true ? (
            <ReviewCount count={reviewCount} />
          ) : null}
        </Link>
      </SidebarMenuButton>
      {item.children === undefined ? null : (
        <SidebarMenuSub>
          {item.children.map((child) => (
            <AdminSubLink
              key={child.href}
              item={child}
              pathname={pathname}
              reviewCount={reviewCount}
            />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

function AdminSubLink({
  item,
  pathname,
  reviewCount,
}: {
  item: NonNullable<AdminNavItem["children"]>[number];
  pathname: string | null;
  reviewCount: number;
}) {
  const { setOpenMobile } = useSidebar();
  const current = isCurrentSection(pathname, item);
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={current}>
        <Link
          href={item.href}
          aria-current={current ? "page" : undefined}
          className={SIDEBAR_LINK_CLASS}
          onClick={() => setOpenMobile(false)}
        >
          {item.label}
          {item.showsReviewCount === true ? (
            <ReviewCount count={reviewCount} />
          ) : null}
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function CurrentSectionLinks({ reviewCount }: { reviewCount: number }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const shownPath = useRef(pathname);

  // A page change by any other way than a link (back and forward) closes the drawer too.
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return <SectionLinks pathname={pathname} reviewCount={reviewCount} />;
}

export function AdminNav({ reviewCount = 0 }: { reviewCount?: number }) {
  return (
    <Sidebar
      className="w-full md:absolute md:h-full md:w-64 md:border-r md:border-sidebar-border md:group-data-[collapsible=offcanvas]:-left-full"
      // `md:absolute` overrides the primitive's `fixed` at md and up, so the container sits in the
      // `relative` admin provider and its 16rem gap lines up with the centered content. Collapsed,
      // the primitive moves it one sidebar width left of the provider; that would leave a sliver
      // visible, so it moves a full container width (the provider is not at the viewport edge).
    >
      <nav aria-label="Admin" className="flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={<SectionLinks pathname={null} reviewCount={reviewCount} />}
        >
          <CurrentSectionLinks reviewCount={reviewCount} />
        </Suspense>
      </nav>
    </Sidebar>
  );
}
