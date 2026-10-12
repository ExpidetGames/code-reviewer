// SPDX-License-Identifier: Apache-2.0

// The content of the Members page: the members with what the viewer may do to them, and (for an Admin or an
// Owner) the form that invites and the invitations that are waiting. `loadMembersPage` gathers the data from
// the services (passed in), `MembersPageContent` renders it. The page file only wires the real ones.
import type { Member } from "../../db/repositories/workspace-members-repository.ts";
import type { MailSender } from "../../mail/sender.ts";
import type { OpenInvitation } from "../invitations.ts";
import { can } from "../permissions.ts";
import type { WorkspaceRole } from "../roles.ts";
import type { WorkspaceApi } from "./api.ts";
import { InvitationList } from "./invitation-list.tsx";
import { InviteForm } from "./invite-form.tsx";
import { MemberList } from "./member-list.tsx";
import { ROLE_HELP, ROLE_LABEL } from "./role-copy.ts";

export type MembersPageData = {
  members: Member[];
  /** Null for a Member: the invitations are not theirs to see. */
  invitations: OpenInvitation[] | null;
  mailConfigured: boolean;
};

export async function loadMembersPage(
  workspaceId: string,
  role: WorkspaceRole,
  deps: {
    members: { list(workspaceId: string): Promise<Member[]> };
    invitations: { listOpen(workspaceId: string): Promise<OpenInvitation[]> };
    mail: Pick<MailSender, "isConfigured">;
  },
): Promise<MembersPageData> {
  const [members, invitations, mailConfigured] = await Promise.all([
    deps.members.list(workspaceId),
    can(role, "view_invitations")
      ? deps.invitations.listOpen(workspaceId)
      : Promise.resolve(null),
    deps.mail.isConfigured(),
  ]);
  return { members, invitations, mailConfigured };
}

export function MembersPageContent({
  workspaceSlug,
  viewerId,
  viewerRole,
  data,
  api,
}: {
  workspaceSlug: string;
  viewerId: string;
  viewerRole: WorkspaceRole;
  data: MembersPageData;
  /** Only tests pass this: a server component cannot hand functions to the client forms. */
  api?: WorkspaceApi;
}) {
  const withApi = api === undefined ? {} : { api };
  return (
    <>
      <p className="muted">
        You are {viewerRole === "admin" ? "an" : "a"}{" "}
        <strong>{ROLE_LABEL[viewerRole]}</strong> of this workspace.{" "}
        {ROLE_HELP[viewerRole]}
      </p>
      <section className="settings-section" aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>
        <MemberList
          workspaceSlug={workspaceSlug}
          viewerId={viewerId}
          viewerRole={viewerRole}
          members={data.members}
          {...withApi}
        />
      </section>
      {data.invitations !== null ? (
        <section
          className="settings-section"
          aria-labelledby="invitations-heading"
        >
          <h2 id="invitations-heading">Invitations</h2>
          <p className="muted">
            {viewerRole === "owner"
              ? "Owners can invite people with any role."
              : "Admins can invite Members."}{" "}
            An invitation is a link that works once, for 7 days, for the address
            it is made for.{" "}
            {data.mailConfigured
              ? "It is sent by mail."
              : "This instance cannot send mail, so the link is shown once for you to send."}
          </p>
          <InviteForm
            workspaceSlug={workspaceSlug}
            viewerRole={viewerRole}
            {...withApi}
          />
          <InvitationList
            workspaceSlug={workspaceSlug}
            viewerRole={viewerRole}
            invitations={data.invitations}
            canResend={data.mailConfigured}
            {...withApi}
          />
        </section>
      ) : null}
    </>
  );
}
