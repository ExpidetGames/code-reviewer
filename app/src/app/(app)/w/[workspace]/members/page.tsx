// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { getMailSender } from "@/mail/shared";
import { PageHeader } from "@/ui/page-header";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { getInvitationService, getMembersService } from "@/workspaces/shared";
import {
  loadMembersPage,
  MembersPageContent,
} from "@/workspaces/ui/members-page";

export const metadata: Metadata = { title: "Members" };

// Who belongs to the workspace and with which role, and (for an Admin or an Owner) the invitations. The
// workspace is the one in the address, for a member only; the buttons show what the role allows and the
// routes decide again.
export default async function MembersPage({
  params,
}: PageProps<"/w/[workspace]/members">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(
    slug,
    "view_members",
  );
  return (
    <>
      <PageHeader
        title="Members"
        description={`Who works in ${workspace.name}.`}
      />
      <MembersContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        viewerId={user.id}
        viewerRole={role}
      />
    </>
  );
}

async function MembersContent({
  workspaceId,
  workspaceSlug,
  viewerId,
  viewerRole,
}: {
  workspaceId: string;
  workspaceSlug: string;
  viewerId: string;
  viewerRole: Parameters<typeof loadMembersPage>[1];
}) {
  const data = await loadMembersPage(workspaceId, viewerRole, {
    members: getMembersService(),
    invitations: getInvitationService(),
    mail: getMailSender(),
  });
  return (
    <MembersPageContent
      workspaceSlug={workspaceSlug}
      viewerId={viewerId}
      viewerRole={viewerRole}
      data={data}
    />
  );
}
