// SPDX-License-Identifier: LicenseRef-Proprietary

// The content of the Members page (#177): one card for the members with what the viewer may do to them, and
// (for an Admin or an Owner) one card for the invitations that holds the invite form, the waiting list and
// its empty state. `loadMembersPage` gathers the data from the services (passed in), `MembersPageContent`
// renders it. The page file only wires the real ones and the heading.
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import type { Member } from "../../db/repositories/workspace-members-repository.ts";
import type { MailSender } from "../../mail/sender.ts";
import type { OpenInvitation } from "../invitations.ts";
import { can } from "../permissions.ts";
import type { WorkspaceRole } from "../../db/workspace-roles.ts";
import type { WorkspaceApi } from "./api.ts";
import { InvitationList } from "./invitation-list.tsx";
import { InviteForm } from "./invite-form.tsx";
import { MemberList } from "./member-list.tsx";

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

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <CardTitle>
      <h2 id={id} className="text-lg leading-7 font-semibold tracking-normal">
        {children}
      </h2>
    </CardTitle>
  );
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
    <div className="flex flex-col gap-6">
      <Card role="region" aria-labelledby="members-heading">
        <CardHeader>
          <SectionTitle id="members-heading">Members</SectionTitle>
        </CardHeader>
        <CardContent>
          <MemberList
            workspaceSlug={workspaceSlug}
            viewerId={viewerId}
            viewerRole={viewerRole}
            members={data.members}
            {...withApi}
          />
        </CardContent>
      </Card>
      {data.invitations !== null ? (
        <Card role="region" aria-labelledby="invitations-heading">
          <CardHeader>
            <SectionTitle id="invitations-heading">Invitations</SectionTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <InviteForm
              workspaceSlug={workspaceSlug}
              viewerRole={viewerRole}
              {...withApi}
            />
            {data.invitations.length === 0 ? (
              <Empty className="border border-border bg-card">
                <EmptyHeader>
                  <EmptyTitle>No invitations waiting.</EmptyTitle>
                  <EmptyDescription>
                    Send an invitation above; it appears here until the person
                    accepts it.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <InvitationList
                workspaceSlug={workspaceSlug}
                viewerRole={viewerRole}
                invitations={data.invitations}
                canResend={data.mailConfigured}
                {...withApi}
              />
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
