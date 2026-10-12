// SPDX-License-Identifier: Apache-2.0

"use client";
// The switch of one project in the list: on means the repository is reviewed. It calls the project
// route, shows what went wrong as a sentence (never a raw code) and refreshes the page data after a
// change. The state shown comes from the server; between the click and the refreshed data the
// switch shows the new state, and it goes back by itself if the call fails.
//
// A switch that cannot be switched on explains itself through `aria-describedby` and a small hint
// next to it, instead of a paragraph on every row (#173-T03).
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { InfoHint } from "../../components/info-hint.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { browserProjectsApi, type ProjectsApi } from "./api.ts";
import { describeFailure } from "./messages.ts";

export function ProjectToggle({
  workspaceSlug,
  repositoryId,
  fullName,
  checked,
  blockedReason,
  canManage = true,
  api: apiProp,
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
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () => browserProjectsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const router = useRouter();
  const messageId = useId();
  // What the last successful call set; the page data catches up after the refresh.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const on = confirmed ?? checked;
  const blocked = (!on && blockedReason !== null) || !canManage;
  const blockedText = canManage
    ? blockedReason
    : "Only Admins and Owners can switch a project on or off.";

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

  const description = problem ?? (blocked ? blockedText : null);
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-1">
        <Switch
          checked={on}
          onCheckedChange={() => void toggle()}
          disabled={pending || blocked}
          aria-label={`Review ${fullName}`}
          aria-describedby={description === null ? undefined : messageId}
        />
        {problem === null && blocked && blockedText !== null ? (
          <InfoHint label={`Why ${fullName} cannot be switched on`}>
            {blockedText}
          </InfoHint>
        ) : null}
      </div>
      {problem !== null ? (
        <p id={messageId} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : blocked && blockedText !== null ? (
        <span id={messageId} className="sr-only">
          {blockedText}
        </span>
      ) : null}
    </div>
  );
}
