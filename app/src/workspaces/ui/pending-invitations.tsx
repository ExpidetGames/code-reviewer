// SPDX-License-Identifier: Apache-2.0

"use client";
// The invitations waiting for the verified address of the signed in account (only while the instance can
// send mail): one row each, with the button that accepts it. Never shown for an unverified address, and
// never without a mail server (src/workspaces/invitations.ts, `listPendingFor`).
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
    <section aria-labelledby="pending-heading" className="pending">
      <h2 id="pending-heading">Invitations for you</h2>
      <ul className="member-list" aria-label="Invitations for you">
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="member-row pending-row"
            data-invitation={invitation.id}
          >
            <div className="member-main">
              <span className="member-name">{invitation.workspaceName}</span>
              <span className="muted small">
                As {ROLE_LABEL[invitation.role]}, until{" "}
                <time dateTime={invitation.expiresAt}>
                  {formatUtc(invitation.expiresAt)}
                </time>
              </span>
            </div>
            <div className="member-actions">
              <AcceptInvitation
                which={{ invitationId: invitation.id }}
                workspaceName={invitation.workspaceName}
                label="Accept"
                {...(api === undefined ? {} : { api })}
                {...(open === undefined ? {} : { open })}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
