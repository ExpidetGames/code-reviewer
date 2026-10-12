// SPDX-License-Identifier: Apache-2.0

"use client";
// The form that invites a person: an email address and a role (an Owner offers all three, an Admin only
// Member). Without a mail server the answer holds the link, which is shown once to be copied; with one the
// link was mailed and is not shown. The page keeps nothing of the link after the next invitation or a
// reload.
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { canInviteAs } from "../permissions.ts";
import { WORKSPACE_ROLES, type WorkspaceRole } from "../roles.ts";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { InvitationLink, type ShownInvitation } from "./invitation-link.tsx";
import { describeWorkspaceFailure } from "./messages.ts";
import { ROLE_LABEL } from "./role-copy.ts";

export function InviteForm({
  workspaceSlug,
  viewerRole,
  api = browserWorkspaceApi(workspaceSlug),
}: {
  workspaceSlug: string;
  viewerRole: WorkspaceRole;
  /** Only tests pass this. */
  api?: WorkspaceApi;
}) {
  const router = useRouter();
  const ids = useId();
  const roles = WORKSPACE_ROLES.filter((role) => canInviteAs(viewerRole, role));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>(roles.at(-1) ?? "member");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownInvitation | null>(null);

  if (roles.length === 0) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setShown(null);
    setPending(true);
    const result = await api.invite(email, role);
    setPending(false);
    if (!result.ok) {
      setProblem(describeWorkspaceFailure(result.code));
      return;
    }
    setShown({
      email: result.data.invitation.email,
      delivery: result.data.delivery,
    });
    setEmail("");
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="settings-form"
      aria-label="Invite a person"
    >
      <fieldset disabled={pending}>
        <legend>Invite a person</legend>
        {problem !== null ? (
          <p role="alert" className="alert alert-error">
            {problem}
          </p>
        ) : null}
        <div className="field">
          <label htmlFor={`${ids}-email`} className="field-label">
            Email address
          </label>
          <input
            id={`${ids}-email`}
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${ids}-role`} className="field-label">
            Role
          </label>
          <select
            id={`${ids}-role`}
            value={role}
            onChange={(event) => setRole(event.target.value as WorkspaceRole)}
          >
            {roles.map((candidate) => (
              <option key={candidate} value={candidate}>
                {ROLE_LABEL[candidate]}
              </option>
            ))}
          </select>
        </div>
        <div className="form-actions">
          <Button type="submit" disabled={pending}>
            {pending ? "Inviting..." : "Send invitation"}
          </Button>
        </div>
      </fieldset>
      {shown !== null ? <InvitationLink shown={shown} /> : null}
    </form>
  );
}
