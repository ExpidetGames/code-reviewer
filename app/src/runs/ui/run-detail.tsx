// SPDX-License-Identifier: Apache-2.0

"use client";
// The detail page of one run: a status banner, then the facts grouped into Summary, Timings and
// Diagnostics, with the runner's log at the end of Diagnostics. The full status description is not
// printed beside the badge; it sits behind the badge's "?" (Summary facts). While the run waits or
// runs the browser asks for newer data; once it is settled it stops. Everything that came from outside
// (the project name, the login, the question of an `/ask`, the log) is rendered as text, and the one
// link made from stored data is the comment link, already checked to be a github.com address.
import Link from "next/link";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "../../components/button.tsx";
import { DescriptionList } from "../../components/description-list.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import { useLiveSnapshot } from "../../ui/use-live-snapshot.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import { formatDuration } from "../run-duration.ts";
import { KIND_NAMES } from "../../review-settings/kind-names.ts";
import { isSettled } from "../run-status.ts";
import type { RunDetailSnapshot, RunDetailView } from "../run-view.ts";
import { browserRunsApi, RUNS_POLL, type RunsApi } from "./api.ts";
import {
  describePollFailure,
  DETAIL_POLL_FAILED_TEXT,
} from "./poll-messages.ts";
import { CallTraceTables } from "./call-trace.tsx";
import { CALL_TRACE_COPY } from "./call-trace-messages.ts";
import { RunStatusBadge } from "./status-badge.tsx";
import { usageItems } from "./usage-facts.tsx";
import { RunPriceText } from "../../workspace-billing/ui/run-price.tsx";

export const NO_LOG_TEXT = "No log available.";
export const LOG_SHORTENED_TEXT =
  "The log was shortened: only the end of it is shown.";

function Time({ value }: { value: string | null }) {
  if (value === null)
    return <span className="text-muted-foreground">Not yet</span>;
  return <time dateTime={value}>{formatUtc(value)}</time>;
}

function DurationText({ run }: { run: RunDetailView }) {
  if (run.durationMs === null)
    return <span className="text-muted-foreground">Not available</span>;
  return (
    <span>
      {formatDuration(run.durationMs)}
      {run.status === "running" ? " so far" : ""}
    </span>
  );
}

function FactGroup({
  title,
  items,
  children,
}: {
  title: string;
  items: readonly { term: ReactNode; description: ReactNode }[];
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2 id={id} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {items.length === 0 ? null : <DescriptionList items={items} />}
        {children}
      </CardContent>
    </Card>
  );
}

/** Copies the log to the clipboard; the result is announced in the one polite region of the panel. */
function CopyLogButton({ text }: { text: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <span className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={() => void copy()}>
        Copy log
      </Button>
      <StatusRegion label="Copying the log">
        {copied === "yes"
          ? "Copied."
          : copied === "failed"
            ? "Copying did not work: select the log and copy it."
            : ""}
      </StatusRegion>
    </span>
  );
}

function LogPanel({ run }: { run: RunDetailView }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">Log</h3>
        {run.log.text !== "" ? <CopyLogButton text={run.log.text} /> : null}
      </div>
      {run.log.text === "" ? (
        <p className="text-sm text-muted-foreground">{NO_LOG_TEXT}</p>
      ) : (
        <>
          {run.log.truncated ? (
            <p className="text-xs text-muted-foreground">
              {LOG_SHORTENED_TEXT}
            </p>
          ) : null}
          <pre
            tabIndex={0}
            aria-label="Log of the run"
            className="max-h-[28rem] overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap"
          >
            {run.log.text}
          </pre>
        </>
      )}
    </div>
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
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () => browserRunsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest: () => api.detail(initial.run.id),
    isSettled: (snapshot) => isSettled(snapshot.run.status),
    activeIntervalMs: RUNS_POLL.activeMs,
    // A settled run does not change any more: no more requests.
    idleIntervalMs: null,
  });
  const run = data.run;

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
  ];
  const usage = usageItems(run);
  summaryItems.push(...usage.model);
  // What the review cost (#505): present only while billing is on and the review was billed.
  if (run.price !== undefined)
    summaryItems.push({
      term: "Price",
      description: <RunPriceText price={run.price} />,
    });
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

  const timingItems: { term: ReactNode; description: ReactNode }[] = [
    { term: "Created", description: <Time value={run.createdAt} /> },
    { term: "Started", description: <Time value={run.startedAt} /> },
    { term: "Finished", description: <Time value={run.finishedAt} /> },
    { term: "Duration", description: <DurationText run={run} /> },
  ];
  if (run.attempts > 0)
    timingItems.push({
      term: "Lost attempts",
      description: (
        <span>
          {run.attempts}{" "}
          <span className="text-muted-foreground">
            (the runner stopped or gave the run back and it was tried again)
          </span>
        </span>
      ),
    });

  const diagnosticItems: { term: ReactNode; description: ReactNode }[] = [
    ...usage.consumption,
  ];
  if (run.commentUrl !== null)
    diagnosticItems.push({
      term: "Review comment",
      description: (
        <a href={run.commentUrl} target="_blank" rel="noopener noreferrer">
          Open the comment on GitHub
        </a>
      ),
    });
  else if (run.commentMissing)
    diagnosticItems.push({
      term: "Review comment",
      description: (
        <span className="text-muted-foreground">
          The review was published, but the link to its comment was not found.
        </span>
      ),
    });
  if (run.supersededBy !== null)
    diagnosticItems.push({
      term: "Superseded by",
      description: (
        <Link
          href={workspacePath(
            workspaceSlug,
            `/runs/${encodeURIComponent(run.supersededBy)}`,
          )}
        >
          The newer run
        </Link>
      ),
    });

  return (
    <div data-slot="run-detail" className="flex max-w-[64rem] flex-col gap-6">
      {/* The one polite region of the page; it stays in the DOM so an update result is announced. */}
      <StatusRegion label="Updating the run" className="text-warning">
        {failed
          ? describePollFailure(failureCode, stopped, DETAIL_POLL_FAILED_TEXT)
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
      </div>
      <FactGroup title="Summary" items={summaryItems} />
      <FactGroup title="Timings" items={timingItems} />
      <FactGroup title="Diagnostics" items={diagnosticItems}>
        <LogPanel run={run} />
      </FactGroup>
      {run.callTrace === null ? null : (
        <FactGroup title={CALL_TRACE_COPY.title} items={[]}>
          <CallTraceTables
            trace={run.callTrace}
            showProviderDetail={!run.costHidden}
          />
        </FactGroup>
      )}
    </div>
  );
}
