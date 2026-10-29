// SPDX-License-Identifier: LicenseRef-Proprietary

// The General sub-page of the workspace settings (#178): the rename (an Owner; everybody else reads
// the name), the plan hand-over, and the one "Needs attention" strip of the area (the configuration hints plus
// the workspace's LLM hint, #173). The Instance facts (tenancy, member count, GitHub App state) are gone (#658):
// the strip already says when the App is not set up, and the members are on their own page. The body is a
// server component; the only interactive part is the rename form.
import type { ProductIdentity } from "../../product-identity/identity.ts";
import {
  NeedsAttention,
  type AttentionNotice,
} from "../../components/needs-attention.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { describeConfigNotices } from "../../config-status/notices.ts";
import type {
  ConfigAudience,
  ConfigStatus,
} from "../../config-status/status.ts";
import type { WorkspaceLlmSummary } from "../../llm/assemble.ts";
import { llmAccessAttention } from "../../llm/ui/llm-access-notice.tsx";
import type { WorkspaceApi } from "./api.ts";
import type { PlanHandoffErrorCode } from "../../plan-handoff/errors.ts";
import { ManagePlanCard } from "../../plan-handoff/ui/manage-plan-card.tsx";
import { LegacyLlmHashRedirect } from "./legacy-llm-hash-redirect.tsx";
import { RenameForm } from "./rename-form.tsx";
import { SettingsScreen } from "./settings-shell.tsx";

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <CardTitle>
      <h2 id={id} className="text-lg leading-7 font-semibold tracking-normal">
        {children}
      </h2>
    </CardTitle>
  );
}

export function GeneralSettingsPageContent({
  product,
  workspaceSlug,
  workspaceName,
  canRename,
  canManageLlmKey,
  canManagePlan = false,
  planError,
  showPlan = false,
  showBilling = false,
  audience = "member",
  config,
  llmSummary,
  api,
}: {
  /** Who the page speaks for (the configuration hints name the product). */
  product: ProductIdentity;
  workspaceSlug: string;
  workspaceName: string;
  /** An Owner may rename the workspace (`rename_workspace`). */
  canRename: boolean;
  /** An Admin or an Owner may change the workspace key; the LLM hint links them to it. */
  canManageLlmKey: boolean;
  /** An Owner or Admin, and the instance has a plan management page: the "Manage plan" button is shown. */
  canManagePlan?: boolean;
  /** Why the last click on "Manage plan" was refused, from the address of the page (`plan_error`). */
  planError?: PlanHandoffErrorCode;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  /** Billing is on (#505): the settings navigation lists the Billing page instead of the Plan page. */
  showBilling?: boolean;
  audience?: ConfigAudience;
  config: ConfigStatus;
  llmSummary: WorkspaceLlmSummary;
  /** Only tests pass this: a server component cannot hand functions to the client form. */
  api?: WorkspaceApi;
}) {
  const llmNotice = llmAccessAttention({
    product: product,
    workspaceSlug,
    summary: llmSummary,
    canManage: canManageLlmKey,
  });
  const notices: AttentionNotice[] = [
    ...describeConfigNotices(product, config, audience),
    ...(llmNotice === null ? [] : [llmNotice]),
  ];
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current=""
      showPlan={showPlan}
      showBilling={showBilling}
    >
      <LegacyLlmHashRedirect workspaceSlug={workspaceSlug} />
      <NeedsAttention notices={notices} />
      <div className="flex max-w-[64rem] flex-col gap-6">
        <Card role="region" aria-labelledby="workspace-heading">
          <CardHeader>
            <SectionTitle id="workspace-heading">Workspace</SectionTitle>
          </CardHeader>
          <CardContent>
            {canRename ? (
              <RenameForm
                workspaceSlug={workspaceSlug}
                initialName={workspaceName}
                {...(api === undefined ? {} : { api })}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                This workspace is called{" "}
                <strong className="text-foreground">{workspaceName}</strong>.
                Only an Owner can rename it.
              </p>
            )}
          </CardContent>
        </Card>
        {canManagePlan ? (
          <ManagePlanCard
            workspaceSlug={workspaceSlug}
            {...(planError === undefined ? {} : { error: planError })}
          />
        ) : null}
      </div>
    </SettingsScreen>
  );
}
