// SPDX-License-Identifier: Apache-2.0

// Integrations: GitHub first. The status of the GitHub App, the one-click and the manual way to configure it,
// the prompts for an App that was imported, and the admin's own GitHub account. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getIntegrationsPageData } from "@/github-config/shared";
import { GithubSection } from "@/github-config/ui/github-section";

export const metadata: Metadata = { title: "Integrations · Admin" };

function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export default async function AdminIntegrationsPage(
  props: PageProps<"/instance-portal/integrations">,
) {
  // The admin first: a person who is not one gets the 404 before anything is read.
  const user = await requireAdmin();
  const data = await getIntegrationsPageData(user.id);
  const query = await props.searchParams;
  return (
    <GithubSection
      {...data}
      outcome={{
        ok: single(query.github),
        error: single(query.github_error),
      }}
    />
  );
}
