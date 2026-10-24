// SPDX-License-Identifier: LicenseRef-Proprietary

// The Integrations index of the admin portal (#182): the status of every service the instance works
// with, one card each, with the link to the page that owns it. The GitHub App page is a route of its
// own (`./github`); the Mail page stays where it is. Instance admin only.
import type { Metadata } from "next";
import { requireAdmin } from "@/admin/session";
import { getAdminService } from "@/admin/shared";
import {
  githubIntegrationCard,
  mailIntegrationCard,
  IntegrationsIndex,
} from "@/admin/ui/integrations-index";
import { getIntegrationsPageData } from "@/github-config/shared";

export const metadata: Metadata = { title: "Integrations · Admin" };

export default async function AdminIntegrationsPage() {
  // The admin first: a person who is not one gets the 404 before anything is read.
  await requireAdmin();
  const [github, settings] = await Promise.all([
    getIntegrationsPageData(),
    getAdminService().readSettings(),
  ]);
  return (
    <IntegrationsIndex
      cards={[
        githubIntegrationCard(github.view),
        mailIntegrationCard(settings),
      ]}
    />
  );
}
