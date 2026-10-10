"use client";
// The list of runs on the Runs page. The server renders the first snapshot; while a run waits or runs
// the browser asks for newer ones (every few seconds), and it keeps asking slowly once everything is
// settled so a run that starts later shows up too. Everything in a run that came from outside (the
// project name, the login) is rendered as text.
import Link from "next/link";
import { EmptyState } from "../../ui/empty-state.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import { useLiveSnapshot } from "../../ui/use-live-snapshot.ts";
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

function TimeLine({ run }: { run: RunRowView }) {
  if (run.startedAt === null)
    return (
      <span className="small">
        {run.status === "queued" ? "Waiting since " : "Created "}
        <time dateTime={run.createdAt}>{formatUtc(run.createdAt)}</time>
      </span>
    );
  return (
    <span className="small">
      Started <time dateTime={run.startedAt}>{formatUtc(run.startedAt)}</time>
    </span>
  );
}

function RunRow({ run }: { run: RunRowView }) {
  return (
    <li className="run-row" data-run-id={run.id}>
      <div className="run-main">
        <Link href={`/runs/${encodeURIComponent(run.id)}`} className="run-link">
          {run.project} #{run.prNumber}
        </Link>
        <span className="muted small">
          /{run.command} &middot; {run.trigger}
        </span>
      </div>
      <div className="run-state">
        <RunStatusBadge status={run.status} />
        {run.problem !== null ? (
          <span className="muted small">{run.problem}</span>
        ) : null}
      </div>
      <div className="run-times">
        <TimeLine run={run} />
        {run.durationMs !== null ? (
          <span className="muted small">
            {run.status === "running" ? "Running for " : "Took "}
            {formatDuration(run.durationMs)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function RunsEmptyState({ filtered }: { filtered: boolean }) {
  if (filtered)
    return (
      <EmptyState
        title="No runs for this filter"
        action={
          <Link href="/runs" className="btn btn-secondary">
            Reset filter
          </Link>
        }
      >
        No run matches the project and status you picked. Reset the filter to
        see all runs.
      </EmptyState>
    );
  return (
    <EmptyState title="No runs yet">
      Reviews of your pull requests will appear here. Switch a project on, then
      open or update a pull request.
    </EmptyState>
  );
}

export function RunsList({
  initial,
  filter,
  api = browserRunsApi,
}: {
  initial: RunsSnapshot;
  filter: RunsFilter;
  api?: RunsApi;
}) {
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
  return (
    <>
      {failed ? (
        <p role="status" className="alert alert-warning run-notice">
          {describePollFailure(failureCode, stopped, POLL_FAILED_TEXT)}
        </p>
      ) : null}
      {data.runs.length === 0 ? (
        <RunsEmptyState filtered={filtered} />
      ) : (
        <ul className="run-list" aria-label="Runs">
          {data.runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
      {data.limited ? (
        <p className="muted small">
          Only the newest {data.runs.length} runs are shown. Filter by project
          or status to narrow the list.
        </p>
      ) : null}
    </>
  );
}
