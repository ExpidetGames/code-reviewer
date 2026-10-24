// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { getWorkspaceLlm } from "@/llm/shared";
import {
  planHandoffErrorOf,
  type PlanHandoffErrorCode,
} from "@/plan-handoff/errors";
import { getPlanManagementUrl } from "@/plan-handoff/shared";
import { billingPageLinkedFor } from "@/billing/shared";
import { planPageLinkedFor } from "@/usage/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { GeneralSettingsPageContent } from "@/workspaces/ui/general-settings-page";

export const metadata: Metadata = { title: "Settings · General" };

// The settings index (#178), the area root: the workspace name (an Owner renames it) and the one "Needs
// attention" strip. The other settings live on the sub-pages (`review-defaults`, `llm`, `advanced`). The workspace is the one in the address, for a
// member only.
export default async function GeneralSettingsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/settings">) {
  const { workspace: slug } = await params;
  // A refused click on "Manage plan" comes back here with a code (src/plan-handoff/errors.ts).
  const planError = planHandoffErrorOf((await searchParams).plan_error);
  const { workspace, role, user } = await requireWorkspace(slug);
  return (
    <GeneralSettingsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      workspaceName={workspace.name}
      canRename={can(role, "rename_workspace")}
      canManageLlmKey={can(role, "manage_llm_key")}
      canManagePlan={can(role, "manage_plan")}
      planError={planError}
      user={user}
    />
  );
}

async function GeneralSettingsContent({
  workspaceId,
  workspaceSlug,
  workspaceName,
  canRename,
  canManageLlmKey,
  canManagePlan,
  planError,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  canRename: boolean;
  canManageLlmKey: boolean;
  /** What the role allows; the button needs the instance's plan management page as well. */
  canManagePlan: boolean;
  planError: PlanHandoffErrorCode | null;
  user: { isInstanceAdmin: boolean };
}) {
  const [config, llmSummary, planManagementUrl, showPlan, showBilling] =
    await Promise.all([
      // Only the instance admin gets the names of the variables that are wrong.
      getConfigStatusFor(user),
      getWorkspaceLlm().summaryFor(workspaceId),
      // Only asked for somebody the role lets through: a Member's page never reads the setting.
      canManagePlan ? getPlanManagementUrl() : Promise.resolve(null),
      planPageLinkedFor(workspaceId),
      billingPageLinkedFor(),
    ]);
  return (
    <GeneralSettingsPageContent
      workspaceSlug={workspaceSlug}
      workspaceName={workspaceName}
      canRename={canRename}
      canManageLlmKey={canManageLlmKey}
      canManagePlan={canManagePlan && planManagementUrl !== null}
      {...(planError === null ? {} : { planError })}
      showPlan={showPlan}
      showBilling={showBilling}
      audience={configAudienceOf(user)}
      config={config}
      llmSummary={llmSummary}
    />
  );
}
