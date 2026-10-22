// SPDX-License-Identifier: Apache-2.0

// The "LLM access" sub-page content (#178): the settings frame and the key card. The page file only
// wires the real key service; the form itself is `LlmAccessSection` (one form, "Save key" and
// "Test key") for each provider. Removal is a destructive action and lives in "Advanced".
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { ProviderKeyStatus } from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";
import {
  LlmAccessSection,
  type CatalogProvidersData,
  type KeyChoice,
} from "./llm-access-section.tsx";

export function LlmSettingsPageContent({
  workspaceSlug,
  canManage,
  keyStatuses,
  catalog,
  summary,
  keyChoice,
  showPlan = false,
  showBilling = false,
  api,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  /** The state of the key of every registered provider. */
  keyStatuses: ProviderKeyStatus[];
  /** The providers of the catalog (#555); absent for a workspace on the instance's access. */
  catalog?: CatalogProvidersData;
  summary: WorkspaceLlmSummary;
  /** Billing is on (#496): what the workspace chose, and whether it has a key of its own. Left out, there is no choice to make. */
  keyChoice?: KeyChoice;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  /** Billing is on (#505): the settings navigation lists the Billing page instead of the Plan page. */
  showBilling?: boolean;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="llm"
      showPlan={showPlan}
      showBilling={showBilling}
    >
      <div>
        <LlmAccessSection
          workspaceSlug={workspaceSlug}
          canManage={canManage}
          keyStatuses={keyStatuses}
          {...(catalog === undefined ? {} : { catalog })}
          summary={summary}
          {...(keyChoice === undefined ? {} : { keyChoice })}
          {...(api === undefined ? {} : { api })}
        />
      </div>
    </SettingsScreen>
  );
}
