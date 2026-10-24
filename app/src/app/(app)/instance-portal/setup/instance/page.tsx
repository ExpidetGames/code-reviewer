// SPDX-License-Identifier: Apache-2.0

// Setup → Instance (#181): the tenancy and the workspace limit as two cards of one form. Instance
// admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { InstanceForm } from "@/admin/ui/instance-form";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "General · Admin" };

export default async function AdminSetupInstancePage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="General"
        breadcrumb={
          <Breadcrumbs
            items={[{ label: "Admin", href: "/admin" }, { label: "Setup" }]}
          />
        }
      />
      <div className="pt-6">
        <InstanceForm settings={settings} />
      </div>
    </>
  );
}
