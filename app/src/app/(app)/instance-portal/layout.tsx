// SPDX-License-Identifier: Apache-2.0

// The frame of the admin portal: the navigation between its sections. The admin check runs before
// anything of the frame is rendered, so a person who is not an admin never sees the section names (the
// proxy has turned them away already; this is the second guard). The check reads the session, so it
// sits behind <Suspense> like the rest of the signed in pages (Cache Components).
import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { requireAdmin } from "@/admin/session";
import { AdminNav } from "@/admin/ui/admin-nav";

export const metadata: Metadata = { title: "Admin" };

export default function AdminLayout({
  children,
}: LayoutProps<"/instance-portal">) {
  return (
    <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
      <AdminFrame>{children}</AdminFrame>
    </Suspense>
  );
}

async function AdminFrame({ children }: { children: ReactNode }) {
  await requireAdmin();
  return (
    <div className="admin-frame">
      <AdminNav />
      {children}
    </div>
  );
}
