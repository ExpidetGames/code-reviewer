// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The button that accepts an invitation. Opening a link accepts nothing; this POST does (a mail scanner or a
// link preview that opens every link in a message must not use one up). The invitation is named by the
// link's token or, from the list of a verified address, by its id.
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { workspaceHome } from "../paths.ts";
import { browserAccountApi, type AccountApi } from "./api.ts";
import { describeWorkspaceFailure } from "./messages.ts";

export function AcceptInvitation({
  which,
  workspaceName,
  label = "Accept invitation",
  api = browserAccountApi,
  open = (path) => window.location.assign(path),
}: {
  which: { token: string } | { invitationId: string };
  workspaceName: string;
  label?: string;
  /** Only tests pass these two. */
  api?: AccountApi;
  open?: (path: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function accept() {
    setProblem(null);
    setPending(true);
    const result = await api.accept(which);
    if (!result.ok) {
      setPending(false);
      setProblem(describeWorkspaceFailure(result.code));
      return;
    }
    // A full navigation: the frame (the switcher) is made again with the new workspace in it.
    open(workspaceHome(result.data.workspace.slug));
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {problem !== null ? (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        loading={pending}
        loadingLabel="Joining"
        aria-label={`${label}: ${workspaceName}`}
        onClick={() => void accept()}
      >
        {label}
      </Button>
    </div>
  );
}
