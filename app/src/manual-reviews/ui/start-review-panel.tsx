// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Review now" panel of a project: it loads the open pull requests of the repository, lets a
// person pick one and starts a review. Everything it knows about pull requests comes from the route;
// what it shows after a start is the answer of the route (a new run, or the run that was already
// waiting or running), with a link to it. Since #203 there is no command selector and no question:
// the only command is `/review`, and whether a project allows it is the `allowedCommands` list.
//
// State is tied to the server's data in the two ways that matter with Cache Components, which keeps
// a page that was left mounted but hidden: the panel is keyed on its repository by the page, and the
// list is loaded in an effect, which a hidden page cleans up and runs again when it is shown, so a
// person who comes back sees fresh pull requests, not the ones from when they left.
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Button } from "../../ui/button.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import type { OpenPullRequests, StartedReview } from "../service.ts";
import { browserManualReviewApi, type ManualReviewApi } from "./api.ts";
import { describeManualReviewFailure, staleListFailure } from "./messages.ts";
import { PullRequestList } from "./pull-request-list.tsx";

type Outcome = { run: StartedReview } | { problem: string } | null;

/** The one command this panel starts; only `/review` exists (#203). */
const COMMAND = "review" as const;

export function StartReviewPanel({
  workspaceSlug,
  repositoryId,
  api: apiProp,
}: {
  /** The workspace of the page: the calls are made in it, and the run it starts is linked in it. */
  workspaceSlug: string;
  repositoryId: string;
  /** Only tests pass this. */
  api?: ManualReviewApi;
}) {
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () => browserManualReviewApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const groupName = useId();
  // The last list that arrived, kept when a later load fails: the sentence about a pull request that
  // was closed stays on screen, the failure is shown beside it.
  const [ready, setReady] = useState<OpenPullRequests | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  // Bumping it loads the list again ("Try again", "Refresh", a stale pull request).
  const [loadCount, setLoadCount] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const reload = useCallback(() => {
    setLoadFailure(null);
    setLoadCount((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    void api.listPullRequests(repositoryId).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setLoadFailure(result.code);
        return;
      }
      setLoadFailure(null);
      setReady(result.data);
      // A pick that is no longer in the list (closed meanwhile) is dropped.
      setSelected((picked) =>
        result.data.pullRequests.some((pr) => pr.number === picked)
          ? picked
          : null,
      );
    });
    return () => {
      current = false;
    };
  }, [api, repositoryId, loadCount]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || ready === null || selected === null) return;
    setOutcome(null);
    setBusy(true);
    const result = await api.startReview(repositoryId, {
      prNumber: selected,
      command: COMMAND,
    });
    setBusy(false);
    if (!result.ok) {
      setOutcome({ problem: describeManualReviewFailure(result.code) });
      if (staleListFailure(result.code)) reload();
      return;
    }
    setOutcome({ run: result.data });
  }

  const loading = ready === null && loadFailure === null;
  const canStart =
    ready !== null &&
    selected !== null &&
    ready.allowedCommands.includes(COMMAND) &&
    !busy;

  return (
    <section
      className="settings-section"
      aria-labelledby={`${groupName}-title`}
    >
      <h2 id={`${groupName}-title`}>Review now</h2>
      <p className="muted">
        Start a review for an open pull request by hand. It does not wait for
        new commits and works for drafts too.
      </p>
      {loading ? (
        <p aria-live="polite" className="muted">
          Loading the open pull requests…
        </p>
      ) : null}
      {loadFailure !== null ? (
        <div role="alert" className="alert alert-error">
          <p>{describeManualReviewFailure(loadFailure)}</p>
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      {ready !== null ? (
        <form
          className="settings-form"
          onSubmit={(event) => void submit(event)}
        >
          <PullRequestList
            pullRequests={ready.pullRequests}
            selected={selected}
            onSelect={(number) => {
              setSelected(number);
              setOutcome(null);
            }}
            name={groupName}
          />
          {ready.allowedCommands.length === 0 ? (
            <p className="muted small">
              Review is switched off in the settings of this project.
            </p>
          ) : null}
          <div className="form-actions">
            <Button type="submit" disabled={!canStart}>
              Review now
            </Button>
            <Button variant="ghost" onClick={reload} disabled={busy}>
              Refresh list
            </Button>
          </div>
          {outcome !== null && "problem" in outcome ? (
            <p role="alert" className="field-error">
              {outcome.problem}
            </p>
          ) : null}
          {outcome !== null && "run" in outcome ? (
            <p role="status" className="alert alert-success">
              {outcome.run.created
                ? `Started: ${outcome.run.command} for pull request #${String(outcome.run.prNumber)}. `
                : `The same ${outcome.run.command} for pull request #${String(outcome.run.prNumber)} is already waiting or running (it may be the run of an earlier commit), so nothing new was started. `}
              <Link
                href={workspacePath(
                  workspaceSlug,
                  `/runs/${encodeURIComponent(outcome.run.runId)}`,
                )}
              >
                View the run
              </Link>
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
