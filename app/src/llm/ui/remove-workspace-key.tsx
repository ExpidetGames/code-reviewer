// SPDX-License-Identifier: Apache-2.0

"use client";
// The destructive part of the workspace key (#178): removing it is confirmed in an AlertDialog (the
// kit's danger zone) before the request, and the result is shown politely. The removal moved out of
// the key form so the "LLM access" sub-page has one job (change the key) and the destructive action
// sits at the end of "Advanced" (rulebook R8).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DangerZone } from "../../components/danger-zone.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { browserLlmKeyApi, type LlmKeyApi } from "./api.ts";
import { describeLlmKeyFailure } from "./messages.ts";

type Outcome = { kind: "removed" } | { kind: "failed"; text: string } | null;

export function RemoveWorkspaceKey({
  workspaceSlug,
  api = browserLlmKeyApi(workspaceSlug),
}: {
  workspaceSlug: string;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function remove() {
    setOutcome(null);
    setPending(true);
    const result = await api.remove();
    setPending(false);
    if (!result.ok) {
      setOutcome({ kind: "failed", text: describeLlmKeyFailure(result.code) });
      return;
    }
    setOutcome({ kind: "removed" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <DangerZone
        title="Remove the workspace key"
        description="Reviews of this workspace cannot run until a new key is saved."
        actionLabel="Remove the key…"
        confirmTitle="Remove the workspace key?"
        confirmDescription="Reviews of this workspace cannot run until a new key is saved. This cannot be undone."
        confirmLabel="Yes, remove it"
        onConfirm={remove}
      >
        {pending ? <StatusRegion>Removing the key…</StatusRegion> : null}
      </DangerZone>
      {outcome?.kind === "removed" ? (
        <StatusRegion>The key is removed.</StatusRegion>
      ) : null}
      {outcome?.kind === "failed" ? (
        <Alert variant="destructive">
          <AlertDescription>{outcome.text}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
