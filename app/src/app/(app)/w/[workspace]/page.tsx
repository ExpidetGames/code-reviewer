// SPDX-License-Identifier: LicenseRef-Proprietary

import { redirect } from "next/navigation";
import { getCapabilities } from "@/capabilities/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { workspaceHome } from "@/workspaces/paths";

// `/w/<slug>` opens the projects of the workspace (its connections where the deployment has no projects). A workspace the person does not belong to is not found.
export default async function WorkspacePage({
  params,
}: PageProps<"/w/[workspace]">) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  redirect(workspaceHome(workspace.slug, getCapabilities()));
}
