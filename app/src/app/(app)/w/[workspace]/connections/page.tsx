// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { lookupSessionId } from "@/auth/session";
import { createInstallationLinkRequestsRepository } from "@/db/repositories/installation-link-requests-repository";
import { createIntegrationsRepository } from "@/db/repositories/integrations-repository";
import { createRepositoriesRepository } from "@/db/repositories/repositories-repository";
import { getDatabase } from "@/db/startup";
import { getInstallationBinding } from "@/installation-binding/shared";
import {
  ConnectionsPageContent,
  loadConnectionsPage,
} from "@/installation-binding/ui/connections-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Connections" };

// The GitHub installations linked to the workspace and, for an Owner or Admin, the buttons that connect one
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9). The workspace is the one in the address, for a
// member only; what a flow that just ended said is in the query, as a code of our own list. The page heading and
// its breadcrumb are rendered by `ConnectionsPageContent` (#176).
export default async function ConnectionsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/connections">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  const query = await searchParams;
  return (
    <ConnectionsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      canManage={can(role, "manage_connections")}
      userId={user.id}
      query={{ github: query.github, picker: query.picker }}
    />
  );
}

async function ConnectionsContent({
  workspaceId,
  workspaceSlug,
  canManage,
  userId,
  query,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
  userId: string;
  query: { github?: unknown; picker?: unknown };
}) {
  const db = getDatabase();
  const sessionId = await lookupSessionId();
  const data = await loadConnectionsPage({
    canManage,
    workspaceId,
    integrations: createIntegrationsRepository(db, workspaceId),
    repositories: createRepositoriesRepository(db, workspaceId),
    linkRequests: createInstallationLinkRequestsRepository(db, workspaceId),
    service: getInstallationBinding().service,
    query,
    actor: sessionId === null ? null : { id: userId, sessionId },
  });
  return (
    <ConnectionsPageContent
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      data={data}
    />
  );
}
