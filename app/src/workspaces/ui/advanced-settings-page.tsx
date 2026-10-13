// SPDX-License-Identifier: Apache-2.0

// The Advanced sub-page of the workspace settings (#178): the destructive actions, each in its own
// danger zone with a confirmation before the request. Removing the workspace key needs
// `manage_llm_key`, resetting the review defaults needs `manage_review_defaults`; a person with
// neither only reads that these actions are not theirs.
import type { LlmKeyApi } from "../../llm/ui/api.ts";
import { RemoveWorkspaceKey } from "../../llm/ui/remove-workspace-key.tsx";
import type { SettingsApi } from "../../review-settings/ui/api.ts";
import { ResetReviewDefaults } from "../../review-settings/ui/reset-defaults.tsx";
import { SettingsScreen } from "./settings-shell.tsx";

export function AdvancedSettingsPageContent({
  workspaceSlug,
  canManageKey,
  keyConfigured,
  canResetDefaults,
  removeApi,
  resetApi,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner (`manage_llm_key`): they may remove the workspace key. */
  canManageKey: boolean;
  /** Whether a workspace key is saved at all (nothing to remove otherwise). */
  keyConfigured: boolean;
  /** An Admin or an Owner (`manage_review_defaults`): they may reset the defaults. */
  canResetDefaults: boolean;
  /** Only tests pass these. */
  removeApi?: LlmKeyApi;
  resetApi?: Pick<SettingsApi, "save">;
}) {
  const showRemove = canManageKey && keyConfigured;
  const showReset = canResetDefaults;
  return (
    <SettingsScreen workspaceSlug={workspaceSlug} current="advanced">
      <div className="flex max-w-[64rem] flex-col gap-6">
        {showRemove ? (
          <RemoveWorkspaceKey
            workspaceSlug={workspaceSlug}
            {...(removeApi === undefined ? {} : { api: removeApi })}
          />
        ) : null}
        {showReset ? (
          <ResetReviewDefaults
            workspaceSlug={workspaceSlug}
            {...(resetApi === undefined ? {} : { api: resetApi })}
          />
        ) : null}
        {!showRemove && !showReset ? (
          <p className="text-sm text-muted-foreground">
            Only an Admin or an Owner of this workspace can remove the key or
            reset the defaults.
          </p>
        ) : null}
      </div>
    </SettingsScreen>
  );
}
