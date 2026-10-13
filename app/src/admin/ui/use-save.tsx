// SPDX-License-Identifier: Apache-2.0

"use client";
// What every form of the admin pages does when it is sent: one or more calls to the data route, a
// sentence for the result, and a refresh of the page's data after any successful change. Nothing
// throws; a failure is a stable code that `messages.ts` turns into a sentence. A form on the Instance
// page saves more than one setting in one submit (#181): `save` runs every change (an independent
// change is never dropped because a neighbour was refused), returns one outcome per change in order,
// and refreshes as soon as one of them succeeded, so "Last changed" stays current also after a partial
// refusal.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RequestIssue } from "../../ui/json-request.ts";
import { browserAdminApi, type AdminApi, type SettingChange } from "./api.ts";
import { describeAdminFailure } from "./messages.ts";

export type SaveOutcome =
  | { kind: "saved" }
  | { kind: "failed"; code: string; text: string; issues: RequestIssue[] };

export type SaveStatus = SaveOutcome | null;

export function useSave(
  api: AdminApi = browserAdminApi,
  workspaceCount?: number,
) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<SaveStatus>(null);

  async function save(...changes: SettingChange[]): Promise<SaveOutcome[]> {
    setPending(true);
    setStatus(null);
    const outcomes: SaveOutcome[] = [];
    let anySaved = false;
    for (const change of changes) {
      const result = await api.change(change);
      if (result.ok) {
        outcomes.push({ kind: "saved" });
        anySaved = true;
        continue;
      }
      outcomes.push({
        kind: "failed",
        code: result.code,
        text: describeAdminFailure(result.code, workspaceCount),
        issues: result.issues,
      });
    }
    setPending(false);
    const firstFailure = outcomes.find((outcome) => outcome.kind === "failed");
    setStatus(firstFailure ?? { kind: "saved" });
    // The page's data comes from the server; a refresh after any successful change keeps "Last
    // changed" current, also when another change of the same submit was refused.
    if (anySaved) router.refresh();
    return outcomes;
  }

  return { pending, status, save };
}

/** The sentence under a form: "Saved." or the reason it was refused. */
export function SaveResult({ status }: { status: SaveStatus }) {
  if (status === null) return <span role="status" />;
  if (status.kind === "saved") return <span role="status">Saved.</span>;
  return (
    <span role="alert" className="field-error">
      {status.text}
    </span>
  );
}
