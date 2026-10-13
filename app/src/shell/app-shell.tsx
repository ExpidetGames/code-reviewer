// SPDX-License-Identifier: Apache-2.0

"use client";
// The frame around every signed in page: the skip link, a header (the drawer trigger, the brand, the
// workspace switcher and the user menu) and the main landmark with the page. The workspace
// navigation is the shadcn Sidebar to the left; on a narrow screen it becomes the Sheet drawer the
// trigger opens. The user menu and the workspace switcher arrive as slots: they need the session, so
// the layout renders them on the server and the frame itself stays static.
import Link from "next/link";
import { Suspense, useId, type ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import {
  CurrentWorkspaceSidebar,
  WorkspaceSidebarTrigger,
} from "./nav-links.tsx";

export function AppShell({
  userMenu,
  workspaceSwitcher,
  children,
}: {
  userMenu: ReactNode;
  /** The workspaces of the signed in person; it needs the session, so it arrives as a slot too. */
  workspaceSwitcher?: ReactNode;
  children: ReactNode;
}) {
  const mainId = useId();

  return (
    // The primitive already gives the wrapper `min-h-svh`; `flex-col` is the only thing the frame
    // adds, so there is a single min-height with no winner to guess (#168 review).
    <SidebarProvider className="flex-col">
      <a
        href={`#${mainId}`}
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-border bg-card">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center gap-3 px-4 py-2">
          {/* Only where a sidebar exists: a page outside a workspace has none, and the admin portal
              brings its own trigger next to the admin sidebar. */}
          <Suspense fallback={null}>
            <WorkspaceSidebarTrigger />
          </Suspense>
          <Link href="/" className="font-bold text-foreground no-underline">
            Code Reviewer
          </Link>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {workspaceSwitcher}
            {userMenu}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Suspense fallback={null}>
          <CurrentWorkspaceSidebar />
        </Suspense>
        <SidebarInset
          id={mainId}
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-12"
        >
          {children}
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
