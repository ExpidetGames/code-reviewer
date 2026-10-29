// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App page of the admin portal (#182): the App's status and addresses, the two ways to
// connect it (only one shows at a time), the sign in with GitHub and the permissions. The admin's
// own GitHub account lives on /account (#179). Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getIntegrationsPageData } from "@/github-config/shared";
import { GithubSection } from "@/github-config/ui/github-section";
import { singleSearchParam } from "@/http/search-params";
import { getProductIdentity } from "@/product-identity/current";

export const metadata: Metadata = { title: "GitHub App · Admin" };

export default async function AdminGithubAppPage(
  props: PageProps<"/instance-portal/integrations/github">,
) {
  // The admin first: a person who is not one gets the 404 before anything is read.
  await requireAdmin();
  const data = await getIntegrationsPageData();
  const query = await props.searchParams;
  return (
    <GithubSection
      product={getProductIdentity()}
      view={data.view}
      tenancy={data.tenancy}
      suggestedName={data.suggestedName}
      conflicts={data.conflicts}
      outcome={{
        ok: singleSearchParam(query.github),
        error: singleSearchParam(query.github_error),
      }}
    />
  );
}
