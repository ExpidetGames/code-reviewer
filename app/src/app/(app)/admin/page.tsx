// SPDX-License-Identifier: Apache-2.0

// The admin area. For now only the landing page of the first-run setup; the portal itself (settings,
// integrations, mail, limits) comes with the next issue. Only the instance admin sees it: anybody else
// gets a 404 as if the page did not exist.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/auth/session";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  const user = await requireUser();
  if (!user.isInstanceAdmin) notFound();
  return (
    <>
      <PageHeader
        title="Admin"
        description={`The setup is finished. You are signed in as ${user.email}.`}
      />
      <p className="muted">
        The settings of this instance (sign-up, GitHub, mail) will appear here.
      </p>
    </>
  );
}
