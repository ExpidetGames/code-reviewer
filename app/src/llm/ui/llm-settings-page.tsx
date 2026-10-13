// SPDX-License-Identifier: Apache-2.0

// The "LLM access" sub-page content (#178): the settings frame and the key card. The page file only
// wires the real key service; the form itself is `LlmAccessSection` (one form, "Save key" and
// "Test key"). Removal is a destructive action and lives in "Advanced".
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { WorkspaceLlmKeyStatus } from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";
import { LlmAccessSection } from "./llm-access-section.tsx";

export function LlmSettingsPageContent({
  workspaceSlug,
  canManage,
  keyStatus,
  summary,
  api,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  keyStatus: WorkspaceLlmKeyStatus;
  summary: WorkspaceLlmSummary;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  return (
    <SettingsScreen workspaceSlug={workspaceSlug} current="llm">
      <div className="max-w-[44rem]">
        <LlmAccessSection
          workspaceSlug={workspaceSlug}
          canManage={canManage}
          keyStatus={keyStatus}
          summary={summary}
          {...(api === undefined ? {} : { api })}
        />
      </div>
    </SettingsScreen>
  );
}
