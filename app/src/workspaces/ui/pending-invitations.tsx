// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The invitations waiting for the verified address of the signed in account (only while the instance can
// send mail): one compact row each (the workspace, its role, the expiry and Accept), under a single
// accessible list name. Never shown for an unverified address, and never without a mail server
// (src/workspaces/invitations.ts, `listPendingFor`).
import { Badge } from "../../components/ui/badge.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { PendingInvitation } from "../invitations.ts";
import { AcceptInvitation } from "./accept-invitation.tsx";
import type { AccountApi } from "./api.ts";
import { ROLE_LABEL } from "./role-copy.ts";

export function PendingInvitations({
  invitations,
  api,
  open,
}: {
  invitations: PendingInvitation[];
  /** Only tests pass these two. */
  api?: AccountApi;
  open?: (path: string) => void;
}) {
  if (invitations.length === 0) return null;
  return (
    <ul
      aria-label="Invitations"
      className="flex flex-col divide-y divide-border"
    >
      {invitations.map((invitation) => (
        <li
          key={invitation.id}
          data-invitation={invitation.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4 first:pt-0 last:pb-0"
        >
          <span className="min-w-0 flex-1 truncate font-semibold">
            {invitation.workspaceName}
          </span>
          <Badge variant="outline">{ROLE_LABEL[invitation.role]}</Badge>
          <span className="text-sm whitespace-nowrap text-muted-foreground">
            Expires{" "}
            <time dateTime={invitation.expiresAt}>
              {formatUtc(invitation.expiresAt)}
            </time>
          </span>
          <AcceptInvitation
            which={{ invitationId: invitation.id }}
            workspaceName={invitation.workspaceName}
            label="Accept"
            {...(api === undefined ? {} : { api })}
            {...(open === undefined ? {} : { open })}
          />
        </li>
      ))}
    </ul>
  );
}
