// SPDX-License-Identifier: LicenseRef-Proprietary

import { redirectToFirstWorkspace } from "@/workspaces/legacy-redirect";

// The old address of the runs (`/runs`, `/runs/<id>`), from before the workspace was in the address: a
// bookmark leads to the same page in the first workspace of the person (src/workspaces/README.md).
export default async function LegacyRunsPage({
  params,
  searchParams,
}: PageProps<"/runs/[[...rest]]">) {
  const { rest } = await params;
  return redirectToFirstWorkspace("runs", rest, await searchParams);
}
