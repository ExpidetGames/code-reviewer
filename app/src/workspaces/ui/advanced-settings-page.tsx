// SPDX-License-Identifier: Apache-2.0

// The Advanced sub-page of the workspace settings (#178): the destructive actions, each in its own
// danger zone with a confirmation before the request. Removing a workspace key (one danger zone for each
// provider that has one, #426) needs
// `manage_llm_key`, resetting the review defaults needs `manage_review_defaults`; a person with
// neither only reads that these actions are not theirs. `RemoveWorkspaceKey` owns whether the key is
// still there, so its confirmation survives the refresh that removes the zone (#178 review M1).
import type { LlmKeyApi } from "../../llm/ui/api.ts";
import { llmProviderDescriptors } from "../../llm/providers/index.ts";
import { RemoveWorkspaceKey } from "../../llm/ui/remove-workspace-key.tsx";
import type { SettingsApi } from "../../review-settings/ui/api.ts";
import { ResetReviewDefaults } from "../../review-settings/ui/reset-defaults.tsx";
import { SettingsScreen } from "./settings-shell.tsx";

export function AdvancedSettingsPageContent({
  workspaceSlug,
  canManageKey,
  keys,
  canResetDefaults,
  showPlan = false,
  removeApi,
  resetApi,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner (`manage_llm_key`): they may remove the workspace key. */
  canManageKey: boolean;
  /**
   * Every registered provider and whether a workspace key of it is saved (nothing to remove otherwise). All of
   * them are listed, so a component that removed its key stays mounted to confirm it.
   */
  keys: ReadonlyArray<{ provider: string; configured: boolean }>;
  /** An Admin or an Owner (`manage_review_defaults`): they may reset the defaults. */
  canResetDefaults: boolean;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  /** Only tests pass these. */
  removeApi?: LlmKeyApi;
  resetApi?: Pick<SettingsApi, "save">;
}) {
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="advanced"
      showPlan={showPlan}
    >
      <div className="flex max-w-[64rem] flex-col gap-6">
        {canManageKey
          ? keys.map(({ provider, configured }) => (
              <RemoveWorkspaceKey
                key={provider}
                workspaceSlug={workspaceSlug}
                provider={provider}
                label={llmProviderDescriptors.labelOf(provider)}
                keyConfigured={configured}
                {...(removeApi === undefined ? {} : { api: removeApi })}
              />
            ))
          : null}
        {canResetDefaults ? (
          <ResetReviewDefaults
            workspaceSlug={workspaceSlug}
            {...(resetApi === undefined ? {} : { api: resetApi })}
          />
        ) : null}
        {!canManageKey && !canResetDefaults ? (
          <p className="text-sm text-muted-foreground">
            Only an Admin or an Owner of this workspace can remove the key or
            reset the defaults.
          </p>
        ) : null}
      </div>
    </SettingsScreen>
  );
}
