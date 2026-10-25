// SPDX-License-Identifier: LicenseRef-Proprietary

// The Plan sub-page of the workspace settings (#282): what the workspace may use and has used in the current
// period, read-only for every member. The page file reads the view (`readPlanView`) and the role; this renders
// it inside the settings frame. An Owner or Admin also finds "Manage plan" here while the instance has a plan
// management page (#284): this is the page the operator's page and the refusal notice lead to.
import type { PlanHandoffErrorCode } from "../../plan-handoff/errors.ts";
import { ManagePlanCard } from "../../plan-handoff/ui/manage-plan-card.tsx";
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import type { PlanView } from "../plan-view.ts";
import type { PlanApi } from "./api.ts";
import { PlanUsage } from "./plan-usage.tsx";

export function PlanPageContent({
  workspaceSlug,
  plan,
  showPlanLink,
  canManagePlan = false,
  planError,
  api,
}: {
  workspaceSlug: string;
  plan: PlanView;
  /** Whether the settings navigation lists this page (the workspace has entitlements). */
  showPlanLink: boolean;
  /** An Owner or Admin, and the instance has a plan management page: the "Manage plan" button is shown. */
  canManagePlan?: boolean;
  planError?: PlanHandoffErrorCode;
  /** Only tests pass this: a server component cannot hand functions to the client component. */
  api?: PlanApi;
}) {
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="plan"
      showPlan={showPlanLink}
    >
      {/* Keyed on nothing: the view is a prop that is new server data when the page is rendered again. */}
      <PlanUsage
        workspaceSlug={workspaceSlug}
        initial={plan}
        {...(api === undefined ? {} : { api })}
      />
      {canManagePlan ? (
        <div className="max-w-[64rem]">
          <ManagePlanCard
            workspaceSlug={workspaceSlug}
            {...(planError === undefined ? {} : { error: planError })}
          />
        </div>
      ) : null}
    </SettingsScreen>
  );
}
