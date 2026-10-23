// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { SettingsAccessProvider } from "@/workspaces/ui/settings-nav";

// The frame of the settings pages of a workspace (#658): it knows the role of the person and tells the sub-navigation whether to
// list "Advanced", which only holds the deletion of the workspace and is the Owner's alone. The pages and the route check the
// role themselves; this only decides what the navigation shows. The answer is handed on as a promise that the navigation reads
// behind its own <Suspense> boundary (see `settings-nav.tsx`), so the layout holds no page back and a page that answers "not
// found" (Advanced for anybody but an Owner) still answers with status 404.
export default function SettingsLayout({
  children,
  params,
}: LayoutProps<"/w/[workspace]/settings">) {
  const showAdvanced = params
    .then(({ workspace: slug }) => requireWorkspace(slug))
    .then(({ role }) => can(role, "delete_workspace"))
    // Not a member, or not signed in: the page answers that itself; the navigation simply has no Advanced link.
    .catch(() => false);
  return (
    <SettingsAccessProvider showAdvanced={showAdvanced}>
      {children}
    </SettingsAccessProvider>
  );
}
