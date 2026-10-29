// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The detail page of one run for a member (#657): a status banner, a Summary (the facts, with the cost and the duration) and
// the Findings, the review the run posted on GitHub. No log, no call trace and no timings: those are for the admin portal.
// While the run waits or runs the browser asks for newer data; once it is settled it stops. Everything that came from outside
// (the project name, the login, the question of an `/ask`, the review text) is rendered as text, and the one link made from
// stored data is the comment link, already checked to be a github.com address.
import { useProductIdentity } from "../../product-identity/context.tsx";
import Link from "next/link";
import { useId, useMemo, type ReactNode } from "react";
import { DescriptionList } from "../../components/description-list.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { useLiveSnapshot } from "../../ui/use-live-snapshot.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import { formatDuration } from "../run-duration.ts";
import { KIND_NAMES } from "../../review-settings/kind-names.ts";
import { isSettled } from "../run-status.ts";
import type { CustomerRunDetailView, RunDetailSnapshot } from "../run-view.ts";
import { browserRunsApi, RUNS_POLL, type RunsApi } from "./api.ts";
import {
  describePollFailure,
  DETAIL_POLL_FAILED_TEXT,
} from "./poll-messages.ts";
import {
  FINDINGS_HEADING,
  FINDINGS_LINK_TEXT,
  FINDINGS_NONE_TEXT,
  FINDINGS_NOT_AVAILABLE_TEXT,
  FINDINGS_NOT_POSTED_TEXT,
  FINDINGS_WAITING_TEXT,
} from "./findings-messages.ts";
import { ReviewText } from "./review-text.tsx";
import { RunStatusBadge } from "./status-badge.tsx";
import { STOPPED_EARLY_TEXT, usageItems } from "./usage-facts.tsx";
import { RunPriceText } from "../../workspace-billing/ui/run-price.tsx";

function DurationText({ run }: { run: CustomerRunDetailView }) {
  if (run.durationMs === null)
    return <span className="text-muted-foreground">Not available</span>;
  return (
    <span>
      {formatDuration(run.durationMs)}
      {run.status === "running" ? " so far" : ""}
    </span>
  );
}

/** A titled card: the heading is the name of the region. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2
            id={id}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            {title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

/**
 * What the run cost: the price while billing is on (what was charged, or not charged), else the cost the runner reported when a
 * member may see it. Nothing when neither exists: a run on the operator's key with billing off has no cost to show.
 */
function costItem(
  run: CustomerRunDetailView,
  usage: ReturnType<typeof usageItems>,
) {
  if (run.price !== undefined)
    return [{ term: "Cost", description: <RunPriceText price={run.price} /> }];
  if (run.costHidden || run.usage === null) return [];
  const cost = usage.consumption.find((item) => item.term === "Cost");
  return cost === undefined ? [] : [cost];
}

/** What the run posted on GitHub: the text of the review, or the reason there is none to show. */
function Findings({ run }: { run: CustomerRunDetailView }) {
  // Only a review that was delivered can be "wrapped up"; a failed Diff Review at its cost limit says so in its failure text.
  const stoppedEarly =
    run.status === "succeeded" ? (run.usage?.stoppedEarly ?? null) : null;
  return (
    <Section title={FINDINGS_HEADING}>
      {run.reviewText !== null ? (
        <ReviewText text={run.reviewText} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {findingsEmptyText(run)}
        </p>
      )}
      {stoppedEarly === null ? null : (
        <p className="text-sm text-warning">
          {STOPPED_EARLY_TEXT[stoppedEarly]}
        </p>
      )}
      {run.commentUrl === null ? null : (
        <p className="text-sm">
          <a href={run.commentUrl} target="_blank" rel="noopener noreferrer">
            {FINDINGS_LINK_TEXT}
          </a>
        </p>
      )}
    </Section>
  );
}

function findingsEmptyText(run: CustomerRunDetailView): string {
  if (run.commentUrl !== null) return FINDINGS_NOT_AVAILABLE_TEXT;
  if (!isSettled(run.status)) return FINDINGS_WAITING_TEXT;
  return run.status === "succeeded"
    ? FINDINGS_NONE_TEXT
    : FINDINGS_NOT_POSTED_TEXT;
}

/** How long after the end of a run its review text is still waited for: the app reads the comment right after the run ends. */
const REVIEW_TEXT_WAIT_MS = 2 * 60 * 1000;

/** A run that posted a review whose text has not arrived yet, in the first minutes after it ended (by the clock of the server). */
function awaitsReviewText(snapshot: RunDetailSnapshot): boolean {
  const { run, generatedAt } = snapshot;
  if (run.commentUrl === null || run.reviewText !== null) return false;
  if (run.finishedAt === null) return false;
  return (
    Date.parse(generatedAt) - Date.parse(run.finishedAt) < REVIEW_TEXT_WAIT_MS
  );
}

export function RunDetail({
  workspaceSlug,
  initial,
  api: apiProp,
}: {
  /** The workspace of the page: the polling and every link stay in it. */
  workspaceSlug: string;
  initial: RunDetailSnapshot;
  api?: RunsApi;
}) {
  const product = useProductIdentity();
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () => browserRunsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest: () => api.detail(initial.run.id),
    isSettled: (snapshot) =>
      isSettled(snapshot.run.status) && !awaitsReviewText(snapshot),
    activeIntervalMs: RUNS_POLL.activeMs,
    // A settled run does not change any more: no more requests.
    idleIntervalMs: null,
  });
  const run = data.run;
  const usage = usageItems(run);

  const summaryItems: { term: ReactNode; description: ReactNode }[] = [
    {
      term: "Project",
      description: (
        <Link
          href={workspacePath(
            workspaceSlug,
            `/projects/${encodeURIComponent(run.repositoryId)}`,
          )}
        >
          {run.project}
        </Link>
      ),
    },
    {
      term: "Pull request",
      description:
        run.prUrl !== null ? (
          <a href={run.prUrl} target="_blank" rel="noopener noreferrer">
            #{run.prNumber} on GitHub
          </a>
        ) : (
          <span>#{run.prNumber}</span>
        ),
    },
    {
      term: "Command",
      description: <code className="font-mono">/{run.command}</code>,
    },
    {
      term: "Review kind",
      description: KIND_NAMES[run.reviewKind],
    },
    ...usage.model,
    ...costItem(run, usage),
    { term: "Duration", description: <DurationText run={run} /> },
  ];
  if (run.args !== "")
    summaryItems.push({
      term: "Question",
      description: (
        <span
          data-slot="run-question"
          className="whitespace-pre-wrap break-words"
        >
          {run.args}
        </span>
      ),
    });
  summaryItems.push(
    { term: "Started by", description: run.trigger },
    {
      term: "Commit",
      description: (
        <code className="font-mono">{run.headSha.slice(0, 12)}</code>
      ),
    },
  );

  return (
    <div data-slot="run-detail" className="flex flex-col gap-6">
      {/* The one polite region of the page; it stays in the DOM so an update result is announced. */}
      <StatusRegion label="Updating the run" className="text-warning">
        {failed
          ? describePollFailure(
              product,
              failureCode,
              stopped,
              DETAIL_POLL_FAILED_TEXT,
            )
          : ""}
      </StatusRegion>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status={run.status} hint />
          {run.problem !== null ? (
            <span className="text-sm text-muted-foreground">{run.problem}</span>
          ) : null}
        </div>
        {run.errorCode !== null ? (
          <p className="text-xs text-muted-foreground">
            Error code: <code className="font-mono">{run.errorCode}</code>
          </p>
        ) : null}
        {run.errorReason !== null ? (
          <p className="text-sm text-muted-foreground">
            {run.errorReason.text}
            <span className="block text-xs">
              Reason: <code className="font-mono">{run.errorReason.code}</code>
            </span>
          </p>
        ) : null}
        {run.supersededBy === null ? null : (
          <p className="text-sm">
            <Link
              href={workspacePath(
                workspaceSlug,
                `/runs/${encodeURIComponent(run.supersededBy)}`,
              )}
            >
              Replaced by a newer run
            </Link>
          </p>
        )}
      </div>
      <Section title="Summary">
        <DescriptionList items={summaryItems} />
      </Section>
      <Findings run={run} />
    </div>
  );
}
