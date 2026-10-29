// SPDX-License-Identifier: LicenseRef-Proprietary

import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { currentLookup } from "@/auth/session";
import { createWorkspacesRepository } from "@/db/repositories/workspaces-repository";
import { getDatabase } from "@/db/startup";
import { loginPath, NO_ACCESS_PAGE } from "@/auth/session-user";
import { getCapabilities } from "@/capabilities/shared";
import { workspaceHome } from "@/workspaces/paths";

// The start page has no content of its own: a signed in person goes to the first workspace they belong to
// (the one they joined first), or, with none, to the page that says what to do (accept an invitation, create
// a workspace, or ask for an invitation). The proxy does this first with a real 307 (src/auth/access-proxy.ts,
// a redirect from here is a 200 with a meta refresh, because the page streams); this is what is left for a
// person with no workspace to lead to. Visitors without a session never get here, the proxy sends them to
// /login first.
export default function Home() {
  return (
    <Suspense fallback={null}>
      <GoToWorkspace />
    </Suspense>
  );
}

async function GoToWorkspace(): Promise<null> {
  // Needs the session and the database, so it never runs at build time.
  await connection();
  const lookup = await currentLookup();
  // Not signed in, still to verify the address, or without a workspace: where the proxy sends them too.
  if (lookup.kind !== "user") redirect(loginPath(lookup));
  const [first] = await createWorkspacesRepository(getDatabase()).listForUser(
    lookup.user.id,
  );
  redirect(
    first === undefined
      ? NO_ACCESS_PAGE
      : workspaceHome(first.workspace.slug, getCapabilities()),
  );
}
