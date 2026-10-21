// SPDX-License-Identifier: Apache-2.0

"use client";
// The list of runs on the Runs page, as a dense table: project, pull request, command, status, time and
// duration. The server renders the first snapshot; while a run waits or runs the browser asks for newer
// ones (every few seconds), and it keeps asking slowly once everything is settled so a run that starts
// later shows up too. Everything in a run that came from outside (the project name, the login) is
// rendered as text and truncated instead of widening the page.
import Link from "next/link";
import { useMemo } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { KIND_NAMES } from "../../review-settings/kind-names.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { useLiveSnapshot } from "../../ui/use-live-snapshot.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import { RunPriceText } from "../../workspace-billing/ui/run-price.tsx";
import { formatDuration } from "../run-duration.ts";
import { isSettled } from "../run-status.ts";
import type { RunRowView, RunsSnapshot } from "../run-view.ts";
import {
  browserRunsApi,
  RUNS_POLL,
  type RunsApi,
  type RunsFilter,
} from "./api.ts";
import { describePollFailure, POLL_FAILED_TEXT } from "./poll-messages.ts";
import { RunStatusBadge } from "./status-badge.tsx";

function runPath(workspaceSlug: string, runId: string): string {
  return workspacePath(workspaceSlug, `/runs/${encodeURIComponent(runId)}`);
}

function TimeLine({ run }: { run: RunRowView }) {
  if (run.startedAt === null)
    return (
      <span className="text-xs text-muted-foreground">
        {run.status === "queued" ? "Waiting since " : "Created "}
        <time dateTime={run.createdAt}>{formatUtc(run.createdAt)}</time>
      </span>
    );
  return (
    <span className="text-xs text-muted-foreground">
      Started <time dateTime={run.startedAt}>{formatUtc(run.startedAt)}</time>
    </span>
  );
}

function DurationLine({ run }: { run: RunRowView }) {
  if (run.durationMs === null)
    return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="text-xs text-muted-foreground">
      {run.status === "running" ? "Running for " : "Took "}
      {formatDuration(run.durationMs)}
    </span>
  );
}

function RunTableRow({
  run,
  workspaceSlug,
  showPrice,
}: {
  run: RunRowView;
  workspaceSlug: string;
  /** The list has a Price column (billing is on and some run has a price). */
  showPrice: boolean;
}) {
  return (
    <TableRow data-run-id={run.id}>
      <TableCell className="min-w-0 align-top whitespace-normal">
        <Link
          href={runPath(workspaceSlug, run.id)}
          // The project name alone repeats for every run of a repository; the PR number makes the
          // link name of a row unique in a screen reader's link list.
          aria-label={`${run.project} #${String(run.prNumber)}`}
          className="block truncate font-medium text-foreground no-underline"
        >
          {run.project}
        </Link>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        {run.prUrl !== null ? (
          <a
            href={run.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline no-underline"
          >
            #{run.prNumber}
          </a>
        ) : (
          <span>#{run.prNumber}</span>
        )}
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <code className="font-mono text-xs">/{run.command}</code>
        {run.reviewKind === "dynamic" ? (
          // Diff Review is the default and stays unmarked; the kind that is not is told by its name.
          <Badge variant="info" className="ml-2">
            {KIND_NAMES.dynamic}
          </Badge>
        ) : null}
        <span className="block text-xs text-muted-foreground">
          {run.trigger}
        </span>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <RunStatusBadge status={run.status} />
        {run.problem !== null ? (
          <span
            className="mt-1 block truncate text-xs text-muted-foreground"
            title={run.problem}
          >
            {run.problem}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <TimeLine run={run} />
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <DurationLine run={run} />
      </TableCell>
      {showPrice ? (
        <TableCell className="align-top whitespace-normal text-xs">
          {run.price === undefined ? null : <RunPriceText price={run.price} />}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

export function RunsEmptyState({
  filtered,
  workspaceSlug,
}: {
  filtered: boolean;
  workspaceSlug: string;
}) {
  if (filtered)
    return (
      <Empty className="border border-border bg-card">
        <EmptyHeader>
          <EmptyTitle>
            <h2>No runs for this filter</h2>
          </EmptyTitle>
          <EmptyDescription>
            No run matches the project and status you picked.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="secondary">
            <Link href={workspacePath(workspaceSlug, "/runs")}>
              Reset filter
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <Empty className="border border-border bg-card">
      <EmptyHeader>
        <EmptyTitle>
          <h2>No runs yet</h2>
        </EmptyTitle>
        <EmptyDescription>
          Reviews of your pull requests appear here once a project is on and a
          pull request is opened or updated.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="primary">
          <Link href={workspacePath(workspaceSlug, "/projects")}>
            Open projects
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function RunsList({
  workspaceSlug,
  initial,
  filter,
  api: apiProp,
}: {
  /** The workspace of the page: the polling and every link stay in it. */
  workspaceSlug: string;
  initial: RunsSnapshot;
  filter: RunsFilter;
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
    fetchLatest: () => api.list(filter),
    isSettled: (snapshot) =>
      snapshot.runs.every((run) => isSettled(run.status)),
    activeIntervalMs: RUNS_POLL.activeMs,
    idleIntervalMs: RUNS_POLL.listIdleMs,
  });
  const filtered =
    filter.repositoryId !== undefined || filter.status !== undefined;
  // The Price column exists only while some run has a price (billing is on, #505): without billing the table is as it was.
  const showPrice = data.runs.some((run) => run.price !== undefined);
  return (
    <>
      {/* The one polite region of the list; it stays in the DOM so an update result is announced. */}
      <StatusRegion label="Updating the list" className="text-warning">
        {failed
          ? describePollFailure(failureCode, stopped, POLL_FAILED_TEXT)
          : ""}
      </StatusRegion>
      {data.runs.length === 0 ? (
        <RunsEmptyState filtered={filtered} workspaceSlug={workspaceSlug} />
      ) : (
        <Table aria-label="Runs" className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className={showPrice ? "w-[24%]" : "w-[32%]"}>
                Project
              </TableHead>
              <TableHead className="w-[8%]">PR</TableHead>
              <TableHead className={showPrice ? "w-[16%]" : "w-[18%]"}>
                Command
              </TableHead>
              <TableHead className={showPrice ? "w-[16%]" : "w-[18%]"}>
                Status
              </TableHead>
              <TableHead className={showPrice ? "w-[13%]" : "w-[14%]"}>
                Time
              </TableHead>
              <TableHead className={showPrice ? "w-[9%]" : "w-[10%]"}>
                Duration
              </TableHead>
              {showPrice ? <TableHead className="w-[14%]">Price</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.runs.map((run) => (
              <RunTableRow
                key={run.id}
                run={run}
                workspaceSlug={workspaceSlug}
                showPrice={showPrice}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {/* A quiet footer line, not a row: the list is capped, not broken. */}
      {data.limited ? (
        <p className="text-xs text-muted-foreground">
          Only the newest {data.runs.length} runs are shown. Filter by project
          or status to narrow the list.
        </p>
      ) : null}
    </>
  );
}
