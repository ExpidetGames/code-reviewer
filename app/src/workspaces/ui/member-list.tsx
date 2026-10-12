// SPDX-License-Identifier: Apache-2.0

"use client";
// The members of a workspace, with what the person looking may do: an Owner changes roles and removes
// anybody, an Admin removes Members, everybody leaves. The buttons only show what the role allows (the
// rules of src/workspaces/permissions.ts); the routes and the service decide for themselves, so a page that
// is out of date, or a request made by hand, gets the refusal. Names and addresses are text somebody else
// typed: rendered as text, never as markup.
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "../../ui/button.tsx";
import type { Member } from "../../db/repositories/workspace-members-repository.ts";
import { canRemoveMemberWithRole } from "../permissions.ts";
import { WORKSPACE_ROLES, type WorkspaceRole } from "../roles.ts";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
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
  const messageId = useId();
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
        <p id={messageId} role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      <ul className="member-list" aria-label="Members">
        {members.map((member) => {
          const self = member.userId === viewerId;
          const canRemove =
            !self && canRemoveMemberWithRole(viewerRole, member.role);
          return (
            <li
              key={member.userId}
              className="member-row"
              data-member={member.userId}
            >
              <div className="member-main">
                <span className="member-name">{member.name}</span>
                <span className="muted small">{member.email}</span>
              </div>
              <div className="member-role">
                {viewerRole === "owner" ? (
                  <select
                    aria-label={`Role of ${member.email}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        api.changeRole(
                          member.userId,
                          event.target.value as WorkspaceRole,
                        ),
                      )
                    }
                  >
                    {WORKSPACE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABEL[role]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="badge">{ROLE_LABEL[member.role]}</span>
                )}
              </div>
              <div className="member-actions">
                {canRemove ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Remove ${member.email}`}
                    onClick={() =>
                      void run(() => api.removeMember(member.userId))
                    }
                  >
                    Remove
                  </Button>
                ) : null}
                {self ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.removeMember(member.userId),
                        // The workspace is not theirs any more: start over from the start page.
                        () => router.push("/"),
                      )
                    }
                  >
                    Leave
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
