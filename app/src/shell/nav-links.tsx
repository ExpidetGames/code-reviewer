// SPDX-License-Identifier: Apache-2.0

"use client";
// The links of the main navigation, on the shadcn Sidebar: the groups of the workspace the page is
// in (none outside a workspace). The sidebar itself reads the current path from the router, which
// can wait for the request on routes with dynamic segments, so the shell wraps it in <Suspense>.
// Every link marks the current page with `aria-current="page"` and closes the narrow-screen drawer.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  isCurrentPage,
  navGroupsFor,
  SIDEBAR_LINK_CLASS,
} from "./nav-items.ts";

/** How much of the top the fixed sidebar leaves to the header (`min-h-14` + its bottom border). */
export const SIDEBAR_TOP_CLASS = "top-14 h-[calc(100svh-3.5rem)]";

export function NavLinks({ pathname }: { pathname: string | null }) {
  const groups = navGroupsFor(pathname);
  if (groups.length === 0) return null;
  return (
    <SidebarContent>
      {groups.map((group, index) => (
        <Fragment key={index}>
          {index > 0 ? <SidebarSeparator /> : null}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="m-0 list-none p-0">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Fragment>
      ))}
    </SidebarContent>
  );
}

function NavLink({
  item,
  pathname,
}: {
  item: { href: string; label: string };
  pathname: string | null;
}) {
  const { setOpenMobile } = useSidebar();
  const current = isCurrentPage(pathname, item.href);
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
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The workspace sidebar of the shell. It reads the current path and renders nothing outside a
 * workspace, so the pages of an account without a workspace (and the admin portal) get no empty
 * column. The `Sidebar` becomes the shadcn Sheet drawer on a narrow screen; a link or a page change
 * closes it.
 */
export function CurrentWorkspaceSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const shownPath = useRef(pathname);

  // The page changed, by whatever means (a link anywhere, back and forward): the drawer has done
  // its job. A click on a nav link closes it sooner through the link's own onClick.
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  if (navGroupsFor(pathname).length === 0) return null;
  return (
    <Sidebar className={SIDEBAR_TOP_CLASS}>
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
        <NavLinks pathname={pathname} />
      </nav>
    </Sidebar>
  );
}

/**
 * The trigger of the workspace sidebar, in the header. It renders only where the sidebar renders, so
 * a page outside a workspace has no control that toggles nothing (the admin portal brings its own
 * trigger next to the admin sidebar).
 */
export function WorkspaceSidebarTrigger() {
  const pathname = usePathname();
  if (navGroupsFor(pathname).length === 0) return null;
  return <SidebarTrigger className="size-11" />;
}
