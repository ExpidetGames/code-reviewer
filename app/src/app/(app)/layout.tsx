// SPDX-License-Identifier: Apache-2.0

// The frame of every signed in page. The frame itself is static; the user menu and the workspace switcher
// need the session, so they stream in behind a <Suspense> boundary (Cache Components), and so does the page,
// which reads the session itself (`requireWorkspace`, `requireUser`). The proxy has already turned away a
// visitor without a session; the pages check again.
import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { actorName } from "@/auth/access-policy";
import { currentLookup, requireSignedIn } from "@/auth/session";
import { AppShell } from "@/shell/app-shell";
import { UserMenu } from "@/shell/user-menu";
import { loadAccountView } from "@/workspaces/account-view";
import { WorkspaceSwitcher } from "@/workspaces/ui/workspace-switcher";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AppShell
      userMenu={
        <Suspense fallback={<span className="avatar" aria-hidden="true" />}>
          <CurrentUserMenu />
        </Suspense>
      }
      workspaceSwitcher={
        <Suspense fallback={null}>
          <CurrentWorkspaceSwitcher />
        </Suspense>
      }
    >
      <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
        {children}
      </Suspense>
    </AppShell>
  );
}

async function CurrentUserMenu() {
  // The frame is for whoever is signed in, also the instance admin whose address is not verified yet
  // (who is in the admin portal); the pages call requireWorkspace() or requireUser() for themselves.
  const user = await requireSignedIn();
  // Only what the menu shows goes to the browser, not the whole session user.
  return (
    <UserMenu
      user={{
        name: user.name,
        login: actorName(user),
        avatarUrl: user.image ?? null,
        isInstanceAdmin: user.isInstanceAdmin,
      }}
      signOutAction={signOut}
    />
  );
}

async function CurrentWorkspaceSwitcher() {
  // Only an account that may use the app has workspaces to show; whoever has to verify the address first
  // gets no switcher.
  const lookup = await currentLookup();
  if (lookup.kind !== "user" && lookup.kind !== "no_workspace") return null;
  const view = await loadAccountView(lookup.user.id);
  return (
    <WorkspaceSwitcher
      workspaces={view.memberships.map(({ workspace }) => ({
        slug: workspace.slug,
        name: workspace.name,
      }))}
      canCreate={view.multiTenant}
      pendingInvitations={view.pending.length}
    />
  );
}
