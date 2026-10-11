// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { requireUser } from "@/auth/session";
import { getConfigStatus } from "@/config-status/shared";
import { getReviewSettingsService } from "@/review-settings/shared";
import {
  GlobalSettingsPageContent,
  loadGlobalSettingsPage,
} from "@/review-settings/ui/global-settings-page";
import { PageHeader } from "@/ui/page-header";

export const metadata: Metadata = { title: "Settings" };

// The state of the instance and the default review settings every project inherits.
export default async function SettingsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Settings" description="How Code Reviewer behaves." />
      <SettingsContent />
    </>
  );
}

async function SettingsContent() {
  const data = await loadGlobalSettingsPage({
    settings: getReviewSettingsService(),
    config: getConfigStatus,
  });
  return <GlobalSettingsPageContent data={data} />;
}
