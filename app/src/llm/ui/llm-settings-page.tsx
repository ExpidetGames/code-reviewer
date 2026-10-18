// SPDX-License-Identifier: Apache-2.0

// The "LLM access" sub-page content (#178): the settings frame and the key card. The page file only
// wires the real key service; the form itself is `LlmAccessSection` (one form, "Save key" and
// "Test key") for each provider. Removal is a destructive action and lives in "Advanced".
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { ProviderKeyStatus } from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";
import { LlmAccessSection } from "./llm-access-section.tsx";

export function LlmSettingsPageContent({
  workspaceSlug,
  canManage,
  keyStatuses,
  summary,
  showPlan = false,
  api,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  /** The state of the key of every registered provider. */
  keyStatuses: ProviderKeyStatus[];
  summary: WorkspaceLlmSummary;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="llm"
      showPlan={showPlan}
    >
      <div className="max-w-[44rem]">
        <LlmAccessSection
          workspaceSlug={workspaceSlug}
          canManage={canManage}
          keyStatuses={keyStatuses}
          summary={summary}
          {...(api === undefined ? {} : { api })}
        />
      </div>
    </SettingsScreen>
  );
}
