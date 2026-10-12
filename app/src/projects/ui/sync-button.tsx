// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Sync from GitHub" button: asks the app to read the repositories from GitHub now, then says how many
// repositories are new and what went wrong, in sentences. The list refreshes afterwards. (The app also syncs
// at start and whenever GitHub reports a change to an installation.) `SyncButton` reads the connections of the
// workspace of the page (an Admin or an Owner); `InstanceSyncButton` reads the whole instance (the instance
// admin, in the admin portal) and notes the installations nobody has linked.
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "../../ui/button.tsx";
import {
  browserInstanceSyncApi,
  browserProjectsApi,
  type InstanceSyncApi,
  type ProjectsApi,
} from "./api.ts";
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

function SyncControl({ api }: { api: Pick<ProjectsApi, "sync"> }) {
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

export function SyncButton({
  workspaceSlug,
  api: apiProp,
}: {
  /** The workspace of the page: the synchronization reads the connections of this workspace. */
  workspaceSlug: string;
  api?: ProjectsApi;
}) {
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () => browserProjectsApi(workspaceSlug),
    [workspaceSlug],
  );
  return <SyncControl api={apiProp ?? defaultApi} />;
}

/** The synchronization of the whole instance, for the instance admin's portal. */
export function InstanceSyncButton({
  api = browserInstanceSyncApi,
}: {
  api?: InstanceSyncApi;
}) {
  return <SyncControl api={api} />;
}
