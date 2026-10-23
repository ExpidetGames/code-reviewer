// SPDX-License-Identifier: Apache-2.0

// The Advanced sub-page of the workspace settings (#658): only the deletion of the workspace, and only for an Owner (the page
// and the route answer a person without that role as if it did not exist, so nothing here checks the role again). What it held
// before moved: removing a stored LLM key is at the end of "LLM", resetting the review defaults at the end of "Review
// defaults".
import { DeleteWorkspaceCard } from "./delete-workspace-card.tsx";
import { SettingsScreen } from "./settings-shell.tsx";
import type { WorkspaceApi } from "./api.ts";

export function AdvancedSettingsPageContent({
  workspaceSlug,
  workspaceName,
  showPlan = false,
  showBilling = false,
  api,
  navigate,
}: {
  workspaceSlug: string;
  workspaceName: string;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  /** Billing is on (#505): the settings navigation lists the Billing page instead of the Plan page. */
  showBilling?: boolean;
  /** Only tests pass these. */
  api?: Pick<WorkspaceApi, "deleteWorkspace">;
  navigate?: (path: string) => void;
}) {
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="advanced"
      showPlan={showPlan}
      showBilling={showBilling}
      showAdvanced
    >
      <div className="flex max-w-[64rem] flex-col gap-6">
        <DeleteWorkspaceCard
          workspaceSlug={workspaceSlug}
          workspaceName={workspaceName}
          {...(api === undefined ? {} : { api })}
          {...(navigate === undefined ? {} : { navigate })}
        />
      </div>
    </SettingsScreen>
  );
}
