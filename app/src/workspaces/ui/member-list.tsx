// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The members of a workspace, with what the person looking may do: an Owner changes roles and removes
// anybody, an Admin removes Members, everybody leaves. The buttons only show what the role allows (the
// rules of src/workspaces/permissions.ts); the routes and the service decide for themselves, so a page that
// is out of date, or a request made by hand, gets the refusal. Names and addresses are text somebody else
// typed: rendered as text, never as markup, and truncated when they are longer than the row (#177). Each row
// starts with the member's GitHub avatar, or the initials of the name without one (#638).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import type { Member } from "../../db/repositories/workspace-members-repository.ts";
import { UserAvatar } from "../../shell/user-avatar.tsx";
import { githubAvatarUrl } from "../../shell/user-display.ts";
import { canRemoveMemberWithRole } from "../permissions.ts";
import { WORKSPACE_ROLES, type WorkspaceRole } from "../roles.ts";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { ConfirmAction } from "./confirm-action.tsx";
import { describeWorkspaceFailure } from "./messages.ts";
import { ROLE_LABEL } from "./role-copy.ts";

export function MemberList({
  workspaceSlug,
  viewerId,
  viewerRole,
  members,
  api = browserWorkspaceApi(workspaceSlug),
}: {
  workspaceSlug: string;
  viewerId: string;
  viewerRole: WorkspaceRole;
  members: Member[];
  /** Only tests pass this. */
  api?: WorkspaceApi;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function run<T extends { ok: boolean }>(
    call: () => Promise<{ ok: true; data: T } | { ok: false; code: string }>,
    after?: () => void,
  ) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setProblem(describeWorkspaceFailure(result.code));
      // The page may be out of date: show what is true now.
      router.refresh();
      return;
    }
    if (after) after();
    else router.refresh();
  }

  return (
    <>
      {problem !== null ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="flex flex-col" aria-label="Members">
        {members.map((member) => {
          const self = member.userId === viewerId;
          const canRemove =
            !self && canRemoveMemberWithRole(viewerRole, member.role);
          return (
            <li
              key={member.userId}
              data-member={member.userId}
              className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0"
            >
              <UserAvatar
                size="lg"
                user={{
                  name: member.name,
                  login: member.email,
                  avatarUrl: githubAvatarUrl(member.githubAccountId),
                }}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold text-foreground">
                  {member.name}
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {member.email}
                </span>
              </div>
              <div className="shrink-0">
                {viewerRole === "owner" ? (
                  <Select
                    value={member.role}
                    disabled={busy}
                    onValueChange={(value) =>
                      void run(() =>
                        api.changeRole(member.userId, value as WorkspaceRole),
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={`Role of ${member.email}`}
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WORKSPACE_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABEL[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline">{ROLE_LABEL[member.role]}</Badge>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canRemove ? (
                  <ConfirmAction
                    actionLabel="Remove"
                    actionName={`Remove ${member.email}`}
                    title={`Remove ${member.email}?`}
                    description="They lose access to this workspace at once. Their account stays, and an invitation brings them back."
                    confirmLabel="Remove"
                    disabled={busy}
                    onConfirm={() => run(() => api.removeMember(member.userId))}
                  />
                ) : null}
                {self ? (
                  <ConfirmAction
                    actionLabel="Leave"
                    actionName="Leave"
                    title="Leave this workspace?"
                    description="You lose access to its projects and runs until somebody invites you again."
                    confirmLabel="Leave the workspace"
                    disabled={busy}
                    onConfirm={() =>
                      run(
                        () => api.removeMember(member.userId),
                        // The workspace is not theirs any more: start over from the start page.
                        () => router.push("/"),
                      )
                    }
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
