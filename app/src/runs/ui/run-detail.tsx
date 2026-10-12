// SPDX-License-Identifier: Apache-2.0

"use client";
// The detail page of one run: what it was about, who or what started it, its status and times, the
// link to the review comment on GitHub, why it did not succeed (in words, with the error code
// beside it) and the end of the runner's log. While the run waits or runs the browser asks for newer
// data; once it is settled it stops. Every text that came from outside is rendered as text, and the
// one link made from stored data is the comment link, already checked to be a github.com address.
import Link from "next/link";
import { useMemo } from "react";
import { formatUtc } from "../../ui/format-time.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import { useLiveSnapshot } from "../../ui/use-live-snapshot.ts";
import { formatDuration } from "../run-duration.ts";
import { isSettled, RUN_STATUS_PRESENTATION } from "../run-status.ts";
import type { RunDetailSnapshot, RunDetailView } from "../run-view.ts";
import { browserRunsApi, RUNS_POLL, type RunsApi } from "./api.ts";
import {
  describePollFailure,
  DETAIL_POLL_FAILED_TEXT,
} from "./poll-messages.ts";
import { RunStatusBadge } from "./status-badge.tsx";

export const NO_LOG_TEXT = "No log available.";
export const LOG_SHORTENED_TEXT =
  "The log was shortened: only the end of it is shown.";

function Time({ value }: { value: string | null }) {
  if (value === null) return <span className="muted">Not yet</span>;
  return <time dateTime={value}>{formatUtc(value)}</time>;
}

function DurationText({ run }: { run: RunDetailView }) {
  if (run.durationMs === null)
    return <span className="muted">Not available</span>;
  return (
    <span>
      {formatDuration(run.durationMs)}
      {run.status === "running" ? " so far" : ""}
    </span>
  );
}

function ErrorFacts({ run }: { run: RunDetailView }) {
  // The sentence comes from the error code table on the server; the code is shown beside it.
  if (run.problem === null) return null;
  return (
    <>
      <dt>What went wrong</dt>
      <dd>
        <p>{run.problem}</p>
        {run.errorCode !== null ? (
          <p className="muted small">
            Error code: <code className="mono">{run.errorCode}</code>
          </p>
        ) : null}
      </dd>
    </>
  );
}

function CommentFacts({ run }: { run: RunDetailView }) {
  if (run.commentUrl !== null)
    return (
      <>
        <dt>Review comment</dt>
        <dd>
          <a href={run.commentUrl} target="_blank" rel="noopener noreferrer">
            Open the comment on GitHub
          </a>
        </dd>
      </>
    );
  if (run.commentMissing)
    return (
      <>
        <dt>Review comment</dt>
        <dd className="muted">
          The review was published, but the link to its comment was not found.
        </dd>
      </>
    );
  return null;
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
  return (
    <div className="run-detail">
      {failed ? (
        <p role="status" className="alert alert-warning">
          {describePollFailure(failureCode, stopped, DETAIL_POLL_FAILED_TEXT)}
        </p>
      ) : null}
      <section aria-labelledby="run-summary">
        <h2 id="run-summary" className="sr-only">
          Summary
        </h2>
        <dl className="run-facts">
          <dt>Status</dt>
          <dd>
            <RunStatusBadge status={run.status} />{" "}
            <span className="muted small">
              {RUN_STATUS_PRESENTATION[run.status].description}
            </span>
          </dd>
          <ErrorFacts run={run} />
          <CommentFacts run={run} />
          <dt>Project</dt>
          <dd>
            <Link
              href={workspacePath(
                workspaceSlug,
                `/projects/${encodeURIComponent(run.repositoryId)}`,
              )}
            >
              {run.project}
            </Link>
          </dd>
          <dt>Pull request</dt>
          <dd>
            {run.prUrl !== null ? (
              <a href={run.prUrl} target="_blank" rel="noopener noreferrer">
                #{run.prNumber} on GitHub
              </a>
            ) : (
              <span>#{run.prNumber}</span>
            )}
          </dd>
          <dt>Command</dt>
          <dd>
            <code className="mono">/{run.command}</code>
          </dd>
          {run.args !== "" ? (
            <>
              <dt>Question</dt>
              <dd className="run-question">{run.args}</dd>
            </>
          ) : null}
          <dt>Started by</dt>
          <dd>{run.trigger}</dd>
          <dt>Commit</dt>
          <dd>
            <code className="mono">{run.headSha.slice(0, 12)}</code>
          </dd>
          <dt>Created</dt>
          <dd>
            <Time value={run.createdAt} />
          </dd>
          <dt>Started</dt>
          <dd>
            <Time value={run.startedAt} />
          </dd>
          <dt>Finished</dt>
          <dd>
            <Time value={run.finishedAt} />
          </dd>
          <dt>Duration</dt>
          <dd>
            <DurationText run={run} />
          </dd>
          {run.attempts > 0 ? (
            <>
              <dt>Lost attempts</dt>
              <dd>
                {run.attempts}{" "}
                <span className="muted small">
                  (the runner stopped or gave the run back and it was tried
                  again)
                </span>
              </dd>
            </>
          ) : null}
          {run.supersededBy !== null ? (
            <>
              <dt>Replaced by</dt>
              <dd>
                <Link
                  href={workspacePath(
                    workspaceSlug,
                    `/runs/${encodeURIComponent(run.supersededBy)}`,
                  )}
                >
                  The newer run
                </Link>
              </dd>
            </>
          ) : null}
        </dl>
      </section>
      <section aria-labelledby="run-log">
        <h2 id="run-log">Log</h2>
        {run.log.text === "" ? (
          <p className="muted">{NO_LOG_TEXT}</p>
        ) : (
          <>
            {run.log.truncated ? (
              <p className="muted small">{LOG_SHORTENED_TEXT}</p>
            ) : null}
            <pre className="run-log" tabIndex={0} aria-label="Log of the run">
              {run.log.text}
            </pre>
          </>
        )}
      </section>
    </div>
  );
}
