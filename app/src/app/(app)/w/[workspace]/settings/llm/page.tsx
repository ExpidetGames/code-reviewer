// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { instanceAccessOf } from "@/llm/access";
import { getWorkspaceLlm } from "@/llm/shared";
import { getNativeCatalog } from "@/native-providers/shared";
import { LlmSettingsPageContent } from "@/llm/ui/llm-settings-page";
import { planPageLinkedFor } from "@/usage/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Settings · LLM access" };

// The LLM access of the workspace (#178): the provider and the write-only key on one form (an Admin or
// an Owner), with "Save key" and "Test key"; a Member only reads whether reviews have a key. Removing
// the key is a destructive action and lives in "Advanced".
export default async function LlmSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings/llm">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <LlmSettingsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      canManage={can(role, "manage_llm_key")}
    />
  );
}

async function LlmSettingsContent({
  workspaceId,
  workspaceSlug,
  canManage,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
}) {
  const llm = getWorkspaceLlm();
  const [keyStatuses, summary, showPlan] = await Promise.all([
    llm.keyServiceFor(workspaceId).statusAll(),
    llm.summaryFor(workspaceId),
    planPageLinkedFor(workspaceId),
  ]);
  // A workspace on the instance's access has no provider to choose: the catalog is not read for it (#555).
  const catalog =
    instanceAccessOf(summary) === null
      ? {
          providers: await getNativeCatalog().providers(),
          keyStatuses: await llm.keyServiceFor(workspaceId).nativeStatuses(),
        }
      : undefined;
  return (
    <LlmSettingsPageContent
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      keyStatuses={keyStatuses}
      {...(catalog === undefined ? {} : { catalog })}
      summary={summary}
      showPlan={showPlan}
    />
  );
}
