// SPDX-License-Identifier: Apache-2.0

// Where somebody who is signed in but belongs to no workspace is sent (docs/decisions/0001-editions-setup-
// and-accounts.md, section 2.6). It shows no data and has what the person needs:
//
// - the invitations that wait for their verified address (only with a mail server),
// - in a multi-tenant instance, the form that creates a workspace (they become its Owner),
// - in a single-tenant instance, the sentence "ask an admin of this instance for an invitation". Nothing
//   joins them automatically, however they got their account.
//
// A person who has a workspace is sent on to it. The proxy lets a person without a workspace reach this
// page and a handful of others (src/auth/access.ts, NO_WORKSPACE_PATHS) and nothing else.
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { currentLookup } from "@/auth/session";
import { loginPath } from "@/auth/session-user";
import { loadAccountView } from "@/workspaces/account-view";
import { workspaceHome } from "@/workspaces/paths";
import { CreateWorkspaceForm } from "@/workspaces/ui/create-workspace-form";
import { PendingInvitations } from "@/workspaces/ui/pending-invitations";
import { Button } from "@/ui/button";

export const metadata: Metadata = { title: "No workspace yet" };

export default function NoAccessPage() {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>No workspace yet</h1>
        <Suspense fallback={null}>
          <WhatToDo />
        </Suspense>
        <form action={signOut}>
          <Button type="submit" variant="secondary" className="btn-block">
            Sign out
          </Button>
        </form>
      </div>
    </main>
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
    <>
      <PendingInvitations invitations={view.pending} />
      {view.multiTenant ? (
        <section aria-labelledby="create-heading">
          <h2 id="create-heading">Create a workspace</h2>
          <p>
            A workspace holds your connections, repositories and reviews, and
            the people you invite. You become its Owner.
          </p>
          <CreateWorkspaceForm />
        </section>
      ) : (
        <p>
          Your account exists, but it is not part of a workspace. Ask an admin
          of this instance for an invitation.
        </p>
      )}
      {lookup.user.isInstanceAdmin ? (
        <p className="muted small">
          You run this instance:{" "}
          <Link href="/admin">open the admin portal</Link>.
        </p>
      ) : null}
    </>
  );
}
