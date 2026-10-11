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
  workspaceSlug,
  repositoryId,
  fullName,
  checked,
  blockedReason,
  canManage = true,
  api = browserProjectsApi(workspaceSlug),
}: {
  /** The workspace of the page: the call is made in it. */
  workspaceSlug: string;
  repositoryId: string;
  fullName: string;
  checked: boolean;
  /** Why the project cannot be switched on right now; a project that is on can always be switched off. */
  blockedReason: string | null;
  /**
   * Whether the person may switch projects on and off (an Admin or an Owner). The switch only shows the
   * state for a Member; the route refuses them in any case (src/workspaces/permissions.ts).
   */
  canManage?: boolean;
  api?: ProjectsApi;
}) {
  const router = useRouter();
  const messageId = useId();
  // What the last successful call set; the page data catches up after the refresh.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const on = confirmed ?? checked;
  const blocked = (!on && blockedReason !== null) || !canManage;

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
          {canManage
            ? blockedReason
            : "Only Admins and Owners can switch a project on or off."}
        </p>
      ) : null}
    </div>
  );
}
