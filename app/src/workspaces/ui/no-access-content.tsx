// SPDX-License-Identifier: Apache-2.0

// What a signed in person without a workspace sees (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.6), as a component over plain data so it is tested without a server:
//
// - the invitations that wait for their verified address (only with a mail server),
// - in a multi-tenant instance, the form that creates a workspace (they become its Owner),
// - in a single-tenant instance, the sentence "ask an admin of this instance for an invitation". Nothing
//   joins them automatically, however they got their account.
import Link from "next/link";
import type { PendingInvitation } from "../invitations.ts";
import type { AccountApi } from "./api.ts";
import { CreateWorkspaceForm } from "./create-workspace-form.tsx";
import { PendingInvitations } from "./pending-invitations.tsx";

export function NoAccessContent({
  multiTenant,
  pending,
  isInstanceAdmin,
  api,
  open,
}: {
  multiTenant: boolean;
  pending: PendingInvitation[];
  isInstanceAdmin: boolean;
  /** Only tests pass these two. */
  api?: AccountApi;
  open?: (path: string) => void;
}) {
  const withApi = {
    ...(api === undefined ? {} : { api }),
    ...(open === undefined ? {} : { open }),
  };
  return (
    <>
      <PendingInvitations invitations={pending} {...withApi} />
      {multiTenant ? (
        <section aria-labelledby="create-heading">
          <h2 id="create-heading">Create a workspace</h2>
          <p>
            A workspace holds your connections, repositories and reviews, and
            the people you invite. You become its Owner.
          </p>
          <CreateWorkspaceForm {...withApi} />
        </section>
      ) : (
        <p>
          Your account exists, but it is not part of a workspace. Ask an admin
          of this instance for an invitation.
        </p>
      )}
      {isInstanceAdmin ? (
        <p className="muted small">
          You run this instance:{" "}
          <Link href="/admin">open the admin portal</Link>.
        </p>
      ) : null}
    </>
  );
}
