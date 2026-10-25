// SPDX-License-Identifier: LicenseRef-Proprietary

// One run for the instance admin (#541): the facts, what it consumed and the table of its calls, by the id of the
// job. An id nobody has shows the not-found page. Instance admin only.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/admin/session";
import { adminRunsService } from "@/admin/runs-shared";
import { AdminRunDetailContent } from "@/admin/ui/runs-page";

export const metadata: Metadata = { title: "Run · Admin" };

export default async function AdminRunPage(
  props: PageProps<"/instance-portal/runs/[id]">,
) {
  await requireAdmin();
  const { id } = await props.params;
  const detail = await adminRunsService().get(id);
  if (detail === undefined) notFound();
  return <AdminRunDetailContent detail={detail} />;
}
