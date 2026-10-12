// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { workspaceHome } from "@/workspaces/paths";

// `/w/<slug>` opens the projects of the workspace. A workspace the person does not belong to is not found.
export default async function WorkspacePage({
  params,
}: PageProps<"/w/[workspace]">) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  redirect(workspaceHome(workspace.slug));
}
