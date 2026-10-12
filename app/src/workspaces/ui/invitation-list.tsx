// SPDX-License-Identifier: Apache-2.0

"use client";
// The invitations of a workspace that are waiting: who, with which role, until when. Revoking and sending
// again follow the rights of inviting with that role (an Admin handles Member invitations only); a resend
// needs a mail server, because a link is shown only once. The link itself is not here: only its hash is
// stored.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../ui/button.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { OpenInvitation } from "../invitations.ts";
import { canInviteAs } from "../permissions.ts";
import type { WorkspaceRole } from "../roles.ts";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { InvitationLink, type ShownInvitation } from "./invitation-link.tsx";
import { describeWorkspaceFailure } from "./messages.ts";
import { ROLE_LABEL } from "./role-copy.ts";

export function InvitationList({
  workspaceSlug,
  viewerRole,
  invitations,
  canResend,
  api = browserWorkspaceApi(workspaceSlug),
}: {
  workspaceSlug: string;
  viewerRole: WorkspaceRole;
  invitations: OpenInvitation[];
  /** Whether the instance can send mail: only then a link can be sent again. */
  canResend: boolean;
  /** Only tests pass this. */
  api?: WorkspaceApi;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownInvitation | null>(null);

  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setShown(null);
    const result = await api.revokeInvitation(id);
    setBusy(false);
    if (!result.ok) setProblem(describeWorkspaceFailure(result.code));
    router.refresh();
  }

  async function resend(id: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setShown(null);
    const result = await api.resendInvitation(id);
    setBusy(false);
    if (!result.ok) {
      setProblem(describeWorkspaceFailure(result.code));
      router.refresh();
      return;
    }
    setShown({
      email: result.data.invitation.email,
      delivery: result.data.delivery,
    });
    router.refresh();
  }

  if (invitations.length === 0)
    return <p className="muted">No invitation is waiting.</p>;

  return (
    <>
      {problem !== null ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      {shown !== null ? <InvitationLink shown={shown} /> : null}
      <ul className="member-list" aria-label="Invitations">
        {invitations.map((invitation) => {
          const allowed = canInviteAs(viewerRole, invitation.role);
          return (
            <li
              key={invitation.id}
              className="member-row"
              data-invitation={invitation.id}
            >
              <div className="member-main">
                <span className="member-name">{invitation.email}</span>
                <span className="muted small">
                  {invitation.expired ? (
                    "Expired"
                  ) : (
                    <>
                      Valid until{" "}
                      <time dateTime={invitation.expiresAt}>
                        {formatUtc(invitation.expiresAt)}
                      </time>
                    </>
                  )}
                </span>
              </div>
              <div className="member-role">
                <span className="badge">{ROLE_LABEL[invitation.role]}</span>
              </div>
              <div className="member-actions">
                {allowed && canResend ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Send the invitation for ${invitation.email} again`}
                    onClick={() => void resend(invitation.id)}
                  >
                    Send again
                  </Button>
                ) : null}
                {allowed ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Revoke the invitation for ${invitation.email}`}
                    onClick={() => void revoke(invitation.id)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
