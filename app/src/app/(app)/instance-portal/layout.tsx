// SPDX-License-Identifier: Apache-2.0

// The frame of the admin portal: the navigation between its sections, on the same shadcn Sidebar as
// the workspace (own provider and trigger, so it becomes the Sheet drawer on a narrow screen). The
// admin check runs before anything of the frame is rendered, so a person who is not an admin never
// sees the section names (the proxy has turned them away already; this is the second guard). The
// check reads the session, so it sits behind <Suspense> like the rest of the signed in pages (Cache
// Components).
import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { requireAdmin } from "@/admin/session";
import { AdminNav } from "@/admin/ui/admin-nav";
import { BillingIncompleteBanner } from "@/admin/ui/billing-incomplete-banner";
import { countOpenBillingReviews, readIncompleteBilling } from "@/billing/shared";
import { PageLoading } from "@/components/page-loading";
import {
  SidebarProvider,
  SidebarShortcut,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export const metadata: Metadata = { title: "Admin" };

export default function AdminLayout({
  children,
}: LayoutProps<"/instance-portal">) {
  return (
    <Suspense fallback={<PageLoading label="Loading the admin portal" />}>
      <AdminFrame>{children}</AdminFrame>
    </Suspense>
  );
}

async function AdminFrame({ children }: { children: ReactNode }) {
  await requireAdmin();
  // The number of billing review rows that are open, next to Billing in the menu: a buyer who paid and was not credited is
  // seen without opening the list (#603).
  // #632: while billing is switched on but not complete, every review is refused; the banner says so on every admin page.
  const [reviewCount, incompleteBilling] = await Promise.all([
    countOpenBillingReviews(),
    readIncompleteBilling(),
  ]);
  return (
    // `relative`: the admin sidebar's container is `absolute` inside it (admin-nav.tsx), and its
    // 16rem gap lines up with the centered content. `min-h-0`: the app frame already sets the
    // viewport minimum, so the admin frame must not add a second one (#168 review).
    <SidebarProvider className="relative min-h-0">
      <AdminNav reviewCount={reviewCount} />
      {/* The shortcut belongs to the provider whose sidebar is rendered; the shell's provider (no
          workspace sidebar on an admin page) has none. */}
      <SidebarShortcut />
      <div className="min-w-0 flex-1">
        {/* The admin sidebar is always visible on a wide screen; on a narrow one this opens it. */}
        <div className="mb-4 md:hidden">
          <SidebarTrigger className="size-11" />
        </div>
        <BillingIncompleteBanner missing={incompleteBilling} />
        {children}
      </div>
    </SidebarProvider>
  );
}
