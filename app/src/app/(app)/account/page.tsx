// SPDX-License-Identifier: Apache-2.0

// Account: the address, and the GitHub account linked to it. Any signed-in person who may use the app.
import type { Metadata } from "next";
import { loadAccount } from "@/account/load";
import { AccountPageContent } from "@/account/ui/account-view";
import { requireUser } from "@/auth/session";
import { getDatabase } from "@/db/startup";
import { isGithubSignInConfigured } from "@/github-config/shared";
import { singleSearchParam } from "@/http/search-params";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage(props: PageProps<"/account">) {
  const user = await requireUser();
  const [account, available, query] = await Promise.all([
    loadAccount(getDatabase(), user.id),
    isGithubSignInConfigured(),
    props.searchParams,
  ]);
  if (account === null) return null;
  return (
    <AccountPageContent
      name={user.name}
      account={account}
      githubSignInAvailable={available}
      isInstanceAdmin={user.isInstanceAdmin}
      outcome={{
        ok: singleSearchParam(query.github),
        error: singleSearchParam(query.github_error),
      }}
    />
  );
}
