// Integrations: GitHub first. A placeholder until the GitHub issue fills it. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { Placeholder } from "@/admin/ui/placeholder";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Integrations · Admin" };

export default async function AdminIntegrationsPage() {
  await requireAdmin();
  return (
    <>
      <PageHeader
        title="Integrations"
        description="The services this instance works with."
      />
      <Placeholder title="GitHub is configured with environment variables for now">
        Setting up the GitHub App in the browser will be here. Until then the
        GitHub App is configured as described in docs/github-app.md.
      </Placeholder>
    </>
  );
}
