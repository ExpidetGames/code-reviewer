// SPDX-License-Identifier: Apache-2.0

// The frame of every signed in page. The frame itself is static; the user menu needs the session,
// so it streams in behind a <Suspense> boundary (Cache Components), and so does the page, which
// reads the session itself (`requireUser`). The proxy has already turned away a visitor without a
// session; the pages check again.
import { Suspense } from "react";
import { signOut } from "@/auth/actions";
import { actorName } from "@/auth/access-policy";
import { requireUser } from "@/auth/session";
import { AppShell } from "@/shell/app-shell";
import { UserMenu } from "@/shell/user-menu";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AppShell
      userMenu={
        <Suspense fallback={<span className="avatar" aria-hidden="true" />}>
          <CurrentUserMenu />
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
  const user = await requireUser();
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
