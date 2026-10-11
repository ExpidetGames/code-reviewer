// Limits: the instance limits. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { LimitsForm } from "@/admin/ui/limits-form";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Limits · Admin" };

export default async function AdminLimitsPage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="Limits"
        description="What users may do on this instance."
      />
      <section className="settings-section">
        <LimitsForm
          key={JSON.stringify(settings.maxWorkspacesPerUser)}
          settings={settings}
        />
      </section>
    </>
  );
}
