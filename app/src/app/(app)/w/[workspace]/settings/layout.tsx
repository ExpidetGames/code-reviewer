// SPDX-License-Identifier: Apache-2.0

import { Suspense, type ReactNode } from "react";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { SettingsAccessProvider } from "@/workspaces/ui/settings-nav";

// The frame of the settings pages of a workspace (#658): it knows the role of the person and tells the sub-navigation whether to
// list "Advanced", which only holds the deletion of the workspace and is the Owner's alone. The pages and the route check the
// role themselves; this only decides what the navigation shows. Like the layout of the workspace it reads the session behind its
// own <Suspense> boundary.
export default function SettingsLayout({
  children,
  params,
}: LayoutProps<"/w/[workspace]/settings">) {
  return (
    <Suspense fallback={null}>
      <SettingsAccess params={params}>{children}</SettingsAccess>
    </Suspense>
  );
}

async function SettingsAccess({
  params,
  children,
}: {
  params: LayoutProps<"/w/[workspace]/settings">["params"];
  children: ReactNode;
}) {
  const { workspace: slug } = await params;
  const { role } = await requireWorkspace(slug);
  return (
    <SettingsAccessProvider showAdvanced={can(role, "delete_workspace")}>
      {children}
    </SettingsAccessProvider>
  );
}
