// SPDX-License-Identifier: Apache-2.0

"use client";
// The switch of one project in the list: on means the repository is reviewed. It calls the project
// route, shows what went wrong as a sentence (never a raw code) and refreshes the page data after a
// change. The state shown comes from the server; between the click and the refreshed data the
// switch shows the new state, and it goes back by itself if the call fails.
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { browserProjectsApi, type ProjectsApi } from "./api.ts";
import { describeFailure } from "./messages.ts";

export function ProjectToggle({
  repositoryId,
  fullName,
  checked,
  blockedReason,
  api = browserProjectsApi,
}: {
  repositoryId: string;
  fullName: string;
  checked: boolean;
  /** Why the project cannot be switched on right now; a project that is on can always be switched off. */
  blockedReason: string | null;
  api?: ProjectsApi;
}) {
  const router = useRouter();
  const messageId = useId();
  // What the last successful call set; the page data catches up after the refresh.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const on = confirmed ?? checked;
  const blocked = !on && blockedReason !== null;

  async function toggle() {
    if (pending || blocked) return;
    setPending(true);
    setProblem(null);
    const result = await api.setActive(repositoryId, !on);
    setPending(false);
    if (!result.ok) {
      setProblem(describeFailure(result.code));
      return;
    }
    setConfirmed(result.data.active);
    router.refresh();
  }

  const describedBy = problem !== null || blocked ? messageId : undefined;
  return (
    <div className="project-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Review ${fullName}`}
        aria-describedby={describedBy}
        className="switch"
        disabled={pending || blocked}
        onClick={() => void toggle()}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
      {problem !== null ? (
        <p id={messageId} role="alert" className="field-error">
          {problem}
        </p>
      ) : blocked ? (
        <p id={messageId} className="muted small">
          {blockedReason}
        </p>
      ) : null}
    </div>
  );
}
