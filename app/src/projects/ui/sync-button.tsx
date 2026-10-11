"use client";
// The "Sync from GitHub" button: asks the app to read the installations and repositories from GitHub
// now, then says how many repositories are new and what went wrong, in sentences. The list refreshes
// afterwards. (The app also syncs at start and whenever GitHub reports a change to an installation.)
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../ui/button.tsx";
import { browserProjectsApi, type ProjectsApi } from "./api.ts";
import { describeFailure, describeSyncProblem } from "./messages.ts";

type Outcome =
  | { kind: "done"; added: number; problems: string[] }
  | { kind: "failed"; text: string };

function addedText(added: number): string {
  if (added === 0) return "No new repositories.";
  return added === 1
    ? "1 new repository."
    : `${String(added)} new repositories.`;
}

export function SyncButton({
  api = browserProjectsApi,
}: {
  api?: ProjectsApi;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function run() {
    setPending(true);
    setOutcome(null);
    const result = await api.sync();
    setPending(false);
    if (!result.ok) {
      setOutcome({ kind: "failed", text: describeFailure(result.code) });
      return;
    }
    setOutcome({
      kind: "done",
      added: result.data.added,
      // One sentence per distinct problem, not one per installation.
      problems: [
        ...new Set(result.data.errors.map((e) => describeSyncProblem(e.code))),
      ],
    });
    router.refresh();
  }

  return (
    <div className="sync">
      <Button variant="secondary" disabled={pending} onClick={() => void run()}>
        {pending ? "Syncing..." : "Sync from GitHub"}
      </Button>
      <div role="status" className="sync-result">
        {outcome?.kind === "failed" ? (
          <span className="field-error">{outcome.text}</span>
        ) : outcome?.kind === "done" ? (
          <>
            <span>{addedText(outcome.added)}</span>
            {outcome.problems.map((text) => (
              <span key={text} className="field-error">
                {text}
              </span>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
