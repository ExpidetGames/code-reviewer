// SPDX-License-Identifier: LicenseRef-Proprietary

// LLM keys: the operator's own key of each provider, for the workspaces whose key mode is managed (#276, #427), and below
// them the model catalog those workspaces choose from (#429). Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import { ModelCatalogSection } from "@/admin/ui/catalog-section";
import { OperatorLlmKeys } from "@/admin/ui/operator-llm-key-form";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { getCatalogAdminService } from "@/model-catalog/shared";

export const metadata: Metadata = { title: "LLM keys · Admin" };

export default async function AdminLlmKeysPage() {
  await requireAdmin();
  const settings = await getAdminService().readSettings();
  const catalog = await getCatalogAdminService().view();
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
      <div className="flex flex-col gap-6 pt-6">
        <div className="flex max-w-[44rem] flex-col gap-6">
          {/* Not keyed on the status: the form keeps its "Saved." sentence while the page's data is refreshed. */}
          <OperatorLlmKeys keys={settings.operatorLlmKeys} />
        </div>
        {/* Wider than the keys: it is a table. Empty and collapsed until the operator needs it, so a self-hoster on their own keys has no new obligation. */}
        <ModelCatalogSection catalog={catalog} />
      </div>
    </>
  );
}
