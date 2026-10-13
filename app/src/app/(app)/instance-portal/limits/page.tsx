// SPDX-License-Identifier: Apache-2.0

// Limits: one field, folded into the instance section (#181). The old deep link stays working and
// leads to it. Instance admin only: anybody else gets the 404 of a page that does not exist.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/admin/session";

export const metadata: Metadata = { title: "Limits · Admin" };

export default async function AdminLimitsRedirectPage() {
  await requireAdmin();
  redirect("/admin/setup/instance");
}
