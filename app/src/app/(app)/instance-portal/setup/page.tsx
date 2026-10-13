// SPDX-License-Identifier: Apache-2.0

// The old address of the setup. The three settings are their own sub-pages now (#181), so this keeps
// the deep link working and sends it to the instance section. Instance admin only: anybody else gets
// the 404 of a page that does not exist (requireAdmin).
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/admin/session";

export const metadata: Metadata = { title: "Setup · Admin" };

export default async function AdminSetupRedirectPage() {
  await requireAdmin();
  redirect("/admin/setup/instance");
}
