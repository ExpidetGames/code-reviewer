// SPDX-License-Identifier: Apache-2.0

// The General sub-page of the workspace settings (#178): the rename (an Owner; everybody else reads
// the name), the read-only instance, tenancy and member facts, and the one "Needs attention" strip of
// the area (the configuration hints plus the workspace's LLM hint, #173). The body is a server
// component; the only interactive part is the rename form.
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
import { InstanceStatus } from "../../config-status/instance-status.tsx";
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
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {children}
      </h2>
    </CardTitle>
  );
}

export function GeneralSettingsPageContent({
  workspaceSlug,
  workspaceName,
  canRename,
  canManageLlmKey,
  canManagePlan = false,
  planError,
  showPlan = false,
  showBilling = false,
  audience = "member",
  tenancy,
  memberCount,
  config,
  llmSummary,
  api,
}: {
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
  tenancy: "single" | "multi";
  memberCount: number;
  config: ConfigStatus;
  llmSummary: WorkspaceLlmSummary;
  /** Only tests pass this: a server component cannot hand functions to the client form. */
  api?: WorkspaceApi;
}) {
  const llmNotice = llmAccessAttention({
    workspaceSlug,
    summary: llmSummary,
    canManage: canManageLlmKey,
  });
  const notices: AttentionNotice[] = [
    ...describeConfigNotices(config, audience),
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
        <Card role="region" aria-labelledby="instance-heading">
          <CardHeader>
            <SectionTitle id="instance-heading">Instance</SectionTitle>
          </CardHeader>
          <CardContent>
            <InstanceStatus
              status={config}
              audience={audience}
              tenancy={tenancy}
              memberCount={memberCount}
            />
          </CardContent>
        </Card>
      </div>
    </SettingsScreen>
  );
}
