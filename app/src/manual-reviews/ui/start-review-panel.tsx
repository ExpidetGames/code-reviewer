// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The body of the "Start a review" dialog of a project (#174, #655): it loads the open pull requests of
// the repository, lets a person pick one and starts a review. Everything it knows about pull requests
// comes from the route; what it shows after a start is the answer of the route (a new run, or the run
// that was already waiting or running), with a link to it. Since #203 there is no command selector and
// no question: the only command is `/review`, and whether a project allows it is the `allowedCommands`
// list. The dialog (`start-review-dialog`) mounts the panel only while it is open, so every opening
// loads fresh pull requests, and the list is loaded in an effect for the same reason.
import { useProductIdentity } from "../../product-identity/context.tsx";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
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
  const product = useProductIdentity();
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
      setOutcome({
        problem: describeManualReviewFailure(product, result.code),
      });
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only">Loading the open pull requests</span>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : null}
      {loadFailure !== null ? (
        <Alert variant="destructive">
          <p>{describeManualReviewFailure(product, loadFailure)}</p>
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </Alert>
      ) : null}
      {ready !== null ? (
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          {/* Only the list scrolls: the actions below stay in view however many pull requests are open. */}
          <div
            className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"
            data-testid="pull-request-scroll"
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
          </div>
          {ready.allowedCommands.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Review is switched off in the settings of this project.
            </p>
          ) : null}
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canStart}>
              Start review
            </Button>
            <Button variant="secondary" onClick={reload} disabled={busy}>
              Refresh list
            </Button>
          </div>
          {outcome !== null && "problem" in outcome ? (
            <Alert variant="destructive">{outcome.problem}</Alert>
          ) : null}
          {outcome !== null && "run" in outcome ? (
            <Alert variant="success" role="status">
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
            </Alert>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
