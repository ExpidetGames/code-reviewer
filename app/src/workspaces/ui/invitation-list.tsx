// SPDX-License-Identifier: Apache-2.0

"use client";
// The invitations of a workspace that are waiting: who, with which role, until when. Revoking and sending
// again follow the rights of inviting with that role (an Admin handles Member invitations only); a resend
// needs a mail server, because a link is shown only once. The link itself is not here: only its hash is
// stored. The empty state is not here either: the Invitations card owns it (#177).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import type { OpenInvitation } from "../invitations.ts";
import { canInviteAs } from "../permissions.ts";
import type { WorkspaceRole } from "../roles.ts";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { ConfirmAction } from "./confirm-action.tsx";
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

  return (
    <div className="flex flex-col gap-3">
      {problem !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {shown !== null ? <InvitationLink shown={shown} /> : null}
      <ul className="flex flex-col" aria-label="Invitations">
        {invitations.map((invitation) => {
          const allowed = canInviteAs(viewerRole, invitation.role);
          return (
            <li
              key={invitation.id}
              data-invitation={invitation.id}
              className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold text-foreground">
                  {invitation.email}
                </span>
                <span className="truncate text-sm text-muted-foreground">
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
              <div className="shrink-0">
                <Badge variant="neutral">{ROLE_LABEL[invitation.role]}</Badge>
              </div>
              <div className="flex shrink-0 items-center gap-2">
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
                  <ConfirmAction
                    actionLabel="Revoke"
                    actionName={`Revoke the invitation for ${invitation.email}`}
                    title={`Revoke the invitation for ${invitation.email}?`}
                    description="The link stops working at once. Inviting the address again makes a new one."
                    confirmLabel="Revoke"
                    disabled={busy}
                    onConfirm={() => revoke(invitation.id)}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
