// SPDX-License-Identifier: Apache-2.0

"use client";
// The destructive part of a workspace key (#178, #426): removing it is confirmed in an AlertDialog (the
// kit's danger zone) before the request, and the result is shown politely. The removal moved out of
// the key form so the "LLM access" sub-page has one job (change the key) and the destructive action
// sits at the end of "Advanced" (rulebook R8).
//
// The component owns the "a key is saved" state: after a removal it stays mounted (the Advanced page
// always renders it for a person who may manage the key) with no zone but the confirmation, so the
// `router.refresh()` that takes the key away does not unmount the result (#178 review M1).
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
  provider,
  label,
  keyConfigured,
  api = browserLlmKeyApi(workspaceSlug),
}: {
  workspaceSlug: string;
  /** The provider whose key this removes; the keys of the others stay. */
  provider: string;
  /**
   * Its name for the person, or null where the person is not told which provider it is (a workspace on the instance's
   * access has no provider to name, but may still hold a key it stored earlier): the words are then "the stored key".
   */
  label: string | null;
  /** Whether the server says a key of this provider is saved right now. */
  keyConfigured: boolean;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  const router = useRouter();
  const [configured, setConfigured] = useState(keyConfigured);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function remove() {
    setOutcome(null);
    setPending(true);
    const result = await api.remove(provider);
    setPending(false);
    if (!result.ok) {
      setOutcome({ kind: "failed", text: describeLlmKeyFailure(result.code) });
      return;
    }
    setConfigured(false);
    setOutcome({ kind: "removed" });
    router.refresh();
  }

  // Nothing to remove and nothing to report.
  if (!configured && outcome?.kind !== "removed") return null;

  const what = label === null ? "the stored key" : `the ${label} key`;
  const consequence =
    label === null
      ? "The key stored earlier is not used by this workspace; removing it deletes it from this server."
      : `Reviews of this workspace cannot run on ${label} until a new key is saved.`;
  return (
    <div className="flex flex-col gap-3">
      {configured ? (
        <DangerZone
          title={`Remove ${what}`}
          description={consequence}
          actionLabel={`Remove ${what}…`}
          confirmTitle={`Remove ${what}?`}
          confirmDescription={`${consequence} This cannot be undone.`}
          confirmLabel="Yes, remove it"
          onConfirm={remove}
        >
          {pending ? <StatusRegion>Removing {what}…</StatusRegion> : null}
        </DangerZone>
      ) : null}
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
