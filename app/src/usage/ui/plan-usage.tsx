// SPDX-License-Identifier: Apache-2.0

"use client";
// The body of the plan page (#282): what the workspace may use in the current period and what it has used. The
// server renders the first view; while the page is open the browser asks for newer ones (`useLiveSnapshot`, as
// the Runs pages do), because reviews start and finish and the operator can change the limits. A failed update
// keeps the last data on screen and says so. Nothing here is told by colour alone: every state has words, and
// the usage bar has a text equivalent that is its accessible name.
import { useId, useMemo } from "react";
import { DescriptionList } from "../../components/description-list.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import {
  PLAN_COST_HEADING,
  PLAN_COST_REACHED,
  PLAN_COST_SOFT_CAP,
  PLAN_CURRENT_HEADING,
  PLAN_LABEL_TERM,
  PLAN_MANAGED,
  PLAN_NO_LIMITS,
  PLAN_PAUSED,
  PLAN_PAUSED_DETAIL,
  PLAN_PAUSED_TITLE,
  PLAN_PERIOD_TERM,
  PLAN_POLL_FAILED,
  PLAN_POLL_STOPPED_SUFFIX,
  PLAN_RUNS_HEADING,
  PLAN_UNREADABLE,
  planCostText,
  planRunsText,
  planUnknownCostText,
} from "../../copy/plan-usage.ts";
import { NOT_AVAILABLE_TO_YOU } from "../../copy/messages.ts";
import { KIND_NAMES } from "../../review-settings/kind-names.ts";
import { formatUtc } from "../../ui/format-time.ts";
import {
  describeTransportFailure,
  TRANSPORT_FAILURE_COPY,
} from "../../ui/transport-messages.ts";
import { useLiveSnapshot } from "../../ui/use-live-snapshot.ts";
import type { CostUsageView, PlanView } from "../plan-view.ts";
import { browserPlanApi, PLAN_POLL, type PlanApi } from "./api.ts";

type Limited = Extract<PlanView, { kind: "limited" }>;

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle>
          <h2 id={headingId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function PausedNotice() {
  const titleId = useId();
  return (
    <Alert variant="warning" role="status" aria-labelledby={titleId}>
      <AlertTitle>
        <span id={titleId}>{PLAN_PAUSED_TITLE}</span>
      </AlertTitle>
      <AlertDescription>
        <p>{PLAN_PAUSED}</p>
        <p>{PLAN_PAUSED_DETAIL}</p>
      </AlertDescription>
    </Alert>
  );
}

function CostUsage({ cost }: { cost: CostUsageView }) {
  const text = planCostText(cost.percentUsed);
  return (
    <Section title={PLAN_COST_HEADING}>
      <p className="text-sm text-foreground">{text}</p>
      {/* The bar repeats the sentence above as its name and its value text, so a screen reader hears it once. */}
      <Progress
        value={cost.percentUsed}
        aria-label={text}
        aria-valuetext={text}
      />
      {cost.percentUsed >= 100 ? (
        <p className="text-sm font-medium text-foreground">
          {PLAN_COST_REACHED}
        </p>
      ) : null}
      {cost.unknownCostCount > 0 ? (
        <p className="text-sm text-foreground">
          {planUnknownCostText(cost.unknownCostCount)}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{PLAN_COST_SOFT_CAP}</p>
    </Section>
  );
}

function RunUsage({ runs }: { runs: NonNullable<Limited["runs"]> }) {
  return (
    <Section title={PLAN_RUNS_HEADING}>
      <DescriptionList
        items={(["diff", "dynamic"] as const).map((kind) => ({
          term: KIND_NAMES[kind],
          description: planRunsText(runs[kind].used, runs[kind].limit),
        }))}
      />
    </Section>
  );
}

function LimitedPlan({ plan }: { plan: Limited }) {
  return (
    <>
      {plan.suspended ? <PausedNotice /> : null}
      <Section title={PLAN_CURRENT_HEADING}>
        <DescriptionList
          items={[
            // Operator text, rendered as text.
            { term: PLAN_LABEL_TERM, description: plan.planLabel },
            {
              term: PLAN_PERIOD_TERM,
              description: (
                <time dateTime={plan.periodStart}>
                  {formatUtc(plan.periodStart)}
                </time>
              ),
            },
          ]}
        />
        {plan.managed ? (
          <p className="text-sm text-muted-foreground">{PLAN_MANAGED}</p>
        ) : null}
      </Section>
      {plan.runs === null ? null : <RunUsage runs={plan.runs} />}
      {plan.cost === null ? null : <CostUsage cost={plan.cost} />}
    </>
  );
}

function PlanBody({ plan }: { plan: PlanView }) {
  if (plan.kind === "unlimited")
    return <p className="text-sm text-muted-foreground">{PLAN_NO_LIMITS}</p>;
  if (plan.kind === "unreadable")
    return (
      <Alert variant="warning" role="status">
        <AlertDescription>
          <p>{PLAN_UNREADABLE}</p>
        </AlertDescription>
      </Alert>
    );
  return <LimitedPlan plan={plan} />;
}

function describeFailure(code: string | null, stopped: boolean): string {
  if (!stopped || code === null) return PLAN_POLL_FAILED;
  const sentence =
    code === "not_found"
      ? NOT_AVAILABLE_TO_YOU
      : (describeTransportFailure(code) ??
        TRANSPORT_FAILURE_COPY.UNEXPECTED_RESPONSE);
  return `${sentence}${PLAN_POLL_STOPPED_SUFFIX}`;
}

export function PlanUsage({
  workspaceSlug,
  initial,
  api: apiProp,
}: {
  /** The workspace of the page: the polling stays in it. */
  workspaceSlug: string;
  initial: PlanView;
  api?: PlanApi;
}) {
  // One client for the life of the component: a new one every render would restart the polling.
  const defaultApi = useMemo(
    () => browserPlanApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest: () => api.read(),
    isSettled: (plan) => plan.kind === "unlimited",
    activeIntervalMs: PLAN_POLL.activeMs,
    idleIntervalMs: PLAN_POLL.idleMs,
  });
  return (
    <div className="flex max-w-[64rem] flex-col gap-6">
      {/* The one polite region for a failed update; it stays in the DOM so a change is announced. */}
      <StatusRegion label="Updating the page" className="text-warning">
        {failed ? describeFailure(failureCode, stopped) : ""}
      </StatusRegion>
      <PlanBody plan={data} />
    </div>
  );
}
