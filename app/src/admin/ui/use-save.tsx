// SPDX-License-Identifier: Apache-2.0

"use client";
// What every form of the admin pages does when it is sent: one or more calls to the data route, a
// sentence for the result, and a refresh of the page's data on success. Nothing throws; a failure is a
// stable code that `messages.ts` turns into a sentence. A form on the Instance page saves more than
// one setting in one submit (#181), so `save` takes any number of changes and stops at the first
// refusal.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RequestIssue } from "../../ui/json-request.ts";
import { browserAdminApi, type AdminApi, type SettingChange } from "./api.ts";
import { describeAdminFailure } from "./messages.ts";

export type SaveStatus =
  | { kind: "saved" }
  | { kind: "failed"; text: string; issues: RequestIssue[] }
  | null;

export function useSave(
  api: AdminApi = browserAdminApi,
  workspaceCount?: number,
) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<SaveStatus>(null);

  async function save(...changes: SettingChange[]): Promise<boolean> {
    setPending(true);
    setStatus(null);
    for (const change of changes) {
      const result = await api.change(change);
      if (!result.ok) {
        setStatus({
          kind: "failed",
          text: describeAdminFailure(result.code, workspaceCount),
          issues: result.issues,
        });
        setPending(false);
        return false;
      }
    }
    setStatus({ kind: "saved" });
    setPending(false);
    // The page's data comes from the server; the refresh shows who changed it and when.
    router.refresh();
    return true;
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
