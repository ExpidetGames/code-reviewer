// SPDX-License-Identifier: Apache-2.0

// Approvals: the requests to link a GitHub installation to a workspace that wait for the instance admin (the role
// of the person in the organization could not be read). Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getInstallationBinding } from "@/installation-binding/shared";
import { ApprovalsPageContent } from "@/installation-binding/ui/approvals-page";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Approvals · Admin" };

export default async function AdminApprovalsPage() {
  await requireAdmin();
  const { pending, decided } = await getInstallationBinding().approvals.list();
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Requests to connect a GitHub installation to a workspace."
      />
      <ApprovalsPageContent pending={pending} decided={decided} />
    </>
  );
}
