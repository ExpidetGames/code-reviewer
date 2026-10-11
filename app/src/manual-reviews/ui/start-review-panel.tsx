"use client";
// The "Review now" panel of a project: it loads the open pull requests of the repository, lets a
// person pick one and a command, and starts it. Everything it knows about pull requests comes from
// the route; what it shows after a start is the answer of the route (a new run, or the run that was
// already waiting or running), with a link to it. State is tied to the server's data in the two
// ways that matter with Cache Components, which keeps a page that was left mounted but hidden:
// the panel is keyed on its repository by the page, and the list is loaded in an effect, which a
// hidden page cleans up and runs again when it is shown, so a person who comes back sees fresh
// pull requests, not the ones from when they left.
import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { ReviewCommand } from "../../integrations/types.ts";
import { Button } from "../../ui/button.tsx";
import type { OpenPullRequests, StartedReview } from "../service.ts";
import { browserManualReviewApi, type ManualReviewApi } from "./api.ts";
import { CommandFields } from "./command-fields.tsx";
import {
  describeManualReviewFailure,
  QUESTION_REQUIRED_COPY,
  staleListFailure,
} from "./messages.ts";
import { PullRequestList } from "./pull-request-list.tsx";

type Outcome = { run: StartedReview } | { problem: string } | null;

export function StartReviewPanel({
  repositoryId,
  api = browserManualReviewApi,
}: {
  repositoryId: string;
  /** Only tests pass this. */
  api?: ManualReviewApi;
}) {
  const groupName = useId();
  // The last list that arrived, kept when a later load fails: a typed question and the sentence about
  // a pull request that was closed stay on screen, the failure is shown beside them.
  const [ready, setReady] = useState<OpenPullRequests | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  // Bumping it loads the list again ("Try again", "Refresh", a stale pull request).
  const [loadCount, setLoadCount] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [command, setCommand] = useState<ReviewCommand>("review");
  const [question, setQuestion] = useState("");
  const [questionError, setQuestionError] = useState<string | null>(null);
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
      // A pick that is no longer in the list (closed meanwhile) is dropped; so is a command that
      // the project switched off meanwhile.
      setSelected((picked) =>
        result.data.pullRequests.some((pr) => pr.number === picked)
          ? picked
          : null,
      );
      setCommand((picked) =>
        result.data.allowedCommands.includes(picked)
          ? picked
          : (result.data.allowedCommands[0] ?? picked),
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
    if (command === "ask" && question.trim() === "") {
      setQuestionError(QUESTION_REQUIRED_COPY);
      return;
    }
    setQuestionError(null);
    setBusy(true);
    const result = await api.startReview(repositoryId, {
      prNumber: selected,
      command,
      ...(command === "ask" ? { question } : {}),
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
    ready.allowedCommands.includes(command) &&
    !busy;

  return (
    <section
      className="settings-section"
      aria-labelledby={`${groupName}-title`}
    >
      <h2 id={`${groupName}-title`}>Review now</h2>
      <p className="muted">
        Start a command for an open pull request by hand. It does not wait for
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
          <CommandFields
            command={command}
            onCommand={(next) => {
              setCommand(next);
              setQuestionError(null);
              setOutcome(null);
            }}
            question={question}
            onQuestion={(next) => {
              setQuestion(next);
              setQuestionError(null);
            }}
            questionError={questionError}
            allowedCommands={ready.allowedCommands}
            disabled={busy}
          />
          {ready.allowedCommands.length === 0 ? (
            <p className="muted small">
              Every command is switched off in the settings of this project.
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
              <Link href={`/runs/${encodeURIComponent(outcome.run.runId)}`}>
                View the run
              </Link>
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
