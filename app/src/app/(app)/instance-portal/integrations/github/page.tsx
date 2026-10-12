// SPDX-License-Identifier: Apache-2.0

// The GitHub App page of the admin portal (#182): the App's status and addresses, the two ways to
// connect it (only one shows at a time), the sign in with GitHub and the permissions. The admin's
// own GitHub account lives on /account (#179). Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getIntegrationsPageData } from "@/github-config/shared";
import { GithubSection } from "@/github-config/ui/github-section";

export const metadata: Metadata = { title: "GitHub App · Admin" };

function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export default async function AdminGithubAppPage(
  props: PageProps<"/instance-portal/integrations/github">,
) {
  // The admin first: a person who is not one gets the 404 before anything is read.
  const user = await requireAdmin();
  const data = await getIntegrationsPageData(user.id);
  const query = await props.searchParams;
  return (
    <GithubSection
      view={data.view}
      tenancy={data.tenancy}
      suggestedName={data.suggestedName}
      conflicts={data.conflicts}
      outcome={{
        ok: single(query.github),
        error: single(query.github_error),
      }}
    />
  );
}
