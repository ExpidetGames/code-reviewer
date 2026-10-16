// SPDX-License-Identifier: Apache-2.0

// LLM key: the operator's own key for the workspaces whose key mode is managed (#276). Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { OperatorLlmKeyForm } from "@/admin/ui/operator-llm-key-form";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "LLM key · Admin" };

export default async function AdminLlmKeyPage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="LLM key"
        breadcrumb={
          <Breadcrumbs
            items={[{ label: "Admin", href: "/admin" }, { label: "LLM key" }]}
          />
        }
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
        {/* Not keyed on the status: the form keeps its "Saved." sentence while the page's data is refreshed. */}
        <OperatorLlmKeyForm status={settings.operatorLlmKey} />
      </div>
    </>
  );
}
