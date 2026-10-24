// SPDX-License-Identifier: LicenseRef-Proprietary

import { redirectToFirstWorkspace } from "@/workspaces/legacy-redirect";

// The old address of the projects (`/projects`, `/projects/<id>`), from before the workspace was in the
// address: a bookmark leads to the same page in the first workspace of the person (src/workspaces/README.md).
export default async function LegacyProjectsPage({
  params,
  searchParams,
}: PageProps<"/projects/[[...rest]]">) {
  const { rest } = await params;
  return redirectToFirstWorkspace("projects", rest, await searchParams);
}
