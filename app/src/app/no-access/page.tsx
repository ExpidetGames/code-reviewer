// SPDX-License-Identifier: Apache-2.0

// Where somebody who is signed in but belongs to no workspace is sent. Public: it shows no data and
// offers to sign out. In a single-tenant instance nothing joins a new account to the workspace, so the
// person asks an admin of the instance for an invitation (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.6); the workspaces issue builds the invitation and the multi-tenant variant.
import type { Metadata } from "next";
import { signOut } from "@/auth/actions";
import { Button } from "@/ui/button";

export const metadata: Metadata = { title: "No access yet" };

export default function NoAccessPage() {
  return (
    <main className="auth-page">
      <div className="card auth-card">
        <h1>No access yet</h1>
        <p>
          Your account exists, but it is not part of a workspace. Ask an admin
          of this instance for an invitation.
        </p>
        <form action={signOut}>
          <Button type="submit" variant="secondary" className="btn-block">
            Sign out
          </Button>
        </form>
      </div>
    </main>
  );
}
