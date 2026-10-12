// SPDX-License-Identifier: Apache-2.0

// Your account: the address, and the GitHub account linked to it. Any signed-in person who may use the app.
import type { Metadata } from "next";
import { loadAccount } from "@/account/load";
import { AccountPageContent } from "@/account/ui/account-view";
import { requireUser } from "@/auth/session";
import { getDatabase } from "@/db/startup";
import { isGithubSignInConfigured } from "@/github-config/shared";

export const metadata: Metadata = { title: "Your account" };

function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

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
      outcome={{ ok: single(query.github), error: single(query.github_error) }}
    />
  );
}
