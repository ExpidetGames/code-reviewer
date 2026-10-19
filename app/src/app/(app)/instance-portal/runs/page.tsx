// SPDX-License-Identifier: Apache-2.0

// Runs: the newest runs of every workspace, for the instance admin (#541). Open one to see what it consumed and
// the table of its calls. Instance admin only: anybody else gets the 404 of a page that does not exist.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { adminRunsService } from "@/admin/runs-shared";
import { AdminRunsListContent } from "@/admin/ui/runs-page";

export const metadata: Metadata = { title: "Runs · Admin" };

export default async function AdminRunsPage() {
  await requireAdmin();
  return <AdminRunsListContent list={await adminRunsService().list()} />;
}
