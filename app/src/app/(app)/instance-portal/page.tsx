// SPDX-License-Identifier: Apache-2.0

// The overview of the admin portal. Only the instance admin sees it: anybody else gets a 404 as if the
// page did not exist (src/admin/access.ts).
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { Overview } from "@/admin/ui/overview";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  const user = await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="Admin"
        description={`The settings of this instance. You are signed in as ${user.email}.`}
      />
      <Overview settings={settings} />
    </>
  );
}
