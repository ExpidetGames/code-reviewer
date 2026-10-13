// SPDX-License-Identifier: Apache-2.0

// Approvals: the requests to link a GitHub installation to a workspace that wait for the instance admin (the role
// of the person in the organization could not be read), and the installations nobody has linked. Instance admin
// only. The screen itself (header, breadcrumb, tabs) is in `installation-binding/ui/approvals-page.tsx`.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getInstallationBinding } from "@/installation-binding/shared";
import { ApprovalsPageContent } from "@/installation-binding/ui/approvals-page";

export const metadata: Metadata = { title: "Approvals · Admin" };

export default async function AdminApprovalsPage() {
  await requireAdmin();
  const binding = getInstallationBinding();
  const [{ pending, decided }, unclaimed] = await Promise.all([
    binding.approvals.list(),
    binding.unclaimed.list(),
  ]);
  return (
    <ApprovalsPageContent
      pending={pending}
      decided={decided}
      unclaimed={unclaimed}
    />
  );
}
