// SPDX-License-Identifier: LicenseRef-Proprietary

// The old addresses of the pages (`/projects`, `/runs/<id>`, `/settings`, from before the workspace was in the
// address) still work as bookmarks: they lead to the same page in the first workspace of the signed in
// person. The proxy does this first, with a real 307 (src/auth/access-proxy.ts); these pages are what is left
// for a request the proxy let through (a person without a workspace, who is sent to the page that says what to
// do). A redirect from a page after Suspense would be a 200 with a meta refresh. Nothing is shown from here: the page they lead to checks the membership like any other, so an old
// link to something that is not in that workspace ends on the not-found page.
import "server-only";
import { redirect } from "next/navigation";
import { currentLookup } from "../auth/session.ts";
import { loginPath, NO_ACCESS_PAGE } from "../auth/session-user.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { workspacePath } from "./paths.ts";

export async function redirectToFirstWorkspace(
  section: "projects" | "runs" | "settings",
  rest: string[] | undefined,
  search: Record<string, string | string[] | undefined>,
): Promise<never> {
  const lookup = await currentLookup();
  if (lookup.kind !== "user") redirect(loginPath(lookup));
  const [first] = await createWorkspacesRepository(getDatabase()).listForUser(
    lookup.user.id,
  );
  if (first === undefined) redirect(NO_ACCESS_PAGE);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    for (const entry of Array.isArray(value) ? value : [value])
      if (entry !== undefined) query.append(key, entry);
  const path = [section, ...(rest ?? []).map(encodeURIComponent)].join("/");
  const text = query.toString();
  redirect(
    workspacePath(
      first.workspace.slug,
      `/${path}${text === "" ? "" : `?${text}`}`,
    ),
  );
}
