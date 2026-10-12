// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { currentLookup } from "@/auth/session";
import { loginPath } from "@/auth/session-user";
import { PageHeader } from "@/components/page-header";
import { loadAccountView } from "@/workspaces/account-view";
import { InvitationsView } from "@/workspaces/ui/invitations-view";

export const metadata: Metadata = { title: "Invitations" };

// The invitations that wait for the verified address of the signed in account. Only with a mail server:
// without one an invitation is accepted through its link and nothing is found by an address.
export default async function InvitationsPage() {
  await connection();
  const lookup = await currentLookup();
  if (lookup.kind !== "user" && lookup.kind !== "no_workspace")
    redirect(loginPath(lookup));
  const view = await loadAccountView(lookup.user.id);
  return (
    <>
      <PageHeader title="Invitations" />
      <div className="pt-6">
        <InvitationsView pending={view.pending} />
      </div>
    </>
  );
}
