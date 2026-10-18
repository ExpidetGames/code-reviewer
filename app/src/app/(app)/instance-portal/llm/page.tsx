// SPDX-License-Identifier: Apache-2.0

// LLM keys: the operator's own key of each provider, for the workspaces whose key mode is managed (#276, #427). Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { OperatorLlmKeys } from "@/admin/ui/operator-llm-key-form";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "LLM keys · Admin" };

export default async function AdminLlmKeysPage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  return (
    <>
      <PageHeader
        title="LLM keys"
        breadcrumb={
          <Breadcrumbs
            items={[{ label: "Admin", href: "/admin" }, { label: "LLM keys" }]}
          />
        }
      />
      <div className="flex max-w-[44rem] flex-col gap-6 pt-6">
        {/* Not keyed on the status: the form keeps its "Saved." sentence while the page's data is refreshed. */}
        <OperatorLlmKeys keys={settings.operatorLlmKeys} />
      </div>
    </>
  );
}
