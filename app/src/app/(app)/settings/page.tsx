// SPDX-License-Identifier: Apache-2.0

import { redirectToFirstWorkspace } from "@/workspaces/legacy-redirect";

// The old address of the settings, from before the workspace was in the address: a bookmark leads to the
// settings of the first workspace of the person (src/workspaces/README.md).
export default async function LegacySettingsPage({
  searchParams,
}: PageProps<"/settings">) {
  return redirectToFirstWorkspace("settings", undefined, await searchParams);
}
