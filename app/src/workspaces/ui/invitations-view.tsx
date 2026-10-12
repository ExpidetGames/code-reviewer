// SPDX-License-Identifier: Apache-2.0

// The invitations page content (#179): while invitations wait, one compact list with one accessible
// name (the workspace, its role, the expiry and Accept); while none do, exactly one empty state. The
// page itself reads the data.
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import type { PendingInvitation } from "../invitations.ts";
import type { AccountApi } from "./api.ts";
import { PendingInvitations } from "./pending-invitations.tsx";

export function InvitationsView({
  pending,
  api,
  open,
}: {
  pending: PendingInvitation[];
  /** Only tests pass these two. */
  api?: AccountApi;
  open?: (path: string) => void;
}) {
  if (pending.length === 0) {
    return (
      <Empty className="border border-border bg-card">
        <EmptyHeader>
          <EmptyTitle>
            <h2>No invitations waiting.</h2>
          </EmptyTitle>
          <EmptyDescription>
            Invitations for your email address show up here once it is
            confirmed.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <PendingInvitations
      invitations={pending}
      {...(api === undefined ? {} : { api })}
      {...(open === undefined ? {} : { open })}
    />
  );
}
