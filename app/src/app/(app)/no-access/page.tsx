// SPDX-License-Identifier: Apache-2.0

// Where somebody who is signed in but belongs to no workspace is sent (docs/decisions/0001-editions-setup-
// and-accounts.md, section 2.6). It shows no data and has what the person needs:
//
// - the invitations that wait for their verified address (only with a mail server),
// - in a multi-tenant instance, the form that creates a workspace (they become its Owner),
// - in a single-tenant instance, the sentence "ask an admin of this instance for an invitation". Nothing
//   joins them automatically, however they got their account.
//
// It lives inside the app frame (`(app)`): signing out is the user menu in the header, not a control in the
// content flow (#171). A person who has a workspace is sent on to it. The proxy lets a person without a
// workspace reach this page and a handful of others (src/auth/access.ts, NO_WORKSPACE_PATHS) and nothing
// else.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { currentLookup } from "@/auth/session";
import { loginPath } from "@/auth/session-user";
import { PageHeader } from "@/components/page-header";
import { loadAccountView } from "@/workspaces/account-view";
import { workspaceHome } from "@/workspaces/paths";
import { NoAccessContent } from "@/workspaces/ui/no-access-content";

export const metadata: Metadata = { title: "No workspace yet" };

export default function NoAccessPage() {
  return (
    <>
      <PageHeader title="No workspace yet" />
      <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
        <WhatToDo />
      </Suspense>
    </>
  );
}

async function WhatToDo() {
  // Needs the session and the database, so it never runs at build time.
  await connection();
  const lookup = await currentLookup();
  if (lookup.kind !== "user" && lookup.kind !== "no_workspace")
    redirect(loginPath(lookup));
  const view = await loadAccountView(lookup.user.id);
  const [first] = view.memberships;
  if (first !== undefined) redirect(workspaceHome(first.workspace.slug));

  return (
    <NoAccessContent
      multiTenant={view.multiTenant}
      pending={view.pending}
      isInstanceAdmin={lookup.user.isInstanceAdmin}
    />
  );
}
