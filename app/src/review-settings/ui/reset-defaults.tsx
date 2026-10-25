// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The destructive reset of the workspace review defaults (#178): every changed default goes back to
// its built-in value. It is confirmed in the kit's danger zone before the request. The reset sends an
// empty patch through the same global settings route as a save (`updateGlobalSettings({})` removes
// every override), so the validation and the authorization are unchanged.
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DangerZone } from "../../components/danger-zone.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { browserGlobalSettingsApi, type SettingsApi } from "./api.ts";
import { followersText } from "./followers-text.ts";
import { describeWholeRefusal } from "./messages.ts";
import type { ProjectReviewKind } from "../settings.ts";

type Outcome = { kind: "reset" } | { kind: "failed"; text: string } | null;

export function ResetReviewDefaults({
  workspaceSlug,
  kindChange,
  api: apiOverride,
}: {
  workspaceSlug: string;
  /**
   * Set when the reset changes the review kind of the defaults (#676): the kind they go back to and how many projects follow
   * them, so the confirmation says who switches. Left out when the kind stays.
   */
  kindChange?: { to: ProjectReviewKind; following?: number };
  /** Only tests pass this. */
  api?: Pick<SettingsApi, "save">;
}) {
  const router = useRouter();
  const defaultApi = useMemo(
    () => browserGlobalSettingsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiOverride ?? defaultApi;
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function reset() {
    setOutcome(null);
    setPending(true);
    const result = await api.save({});
    setPending(false);
    if (!result.ok) {
      // The refusal names the projects that hold the reset back, as the form does.
      setOutcome({ kind: "failed", text: describeWholeRefusal(result) });
      return;
    }
    setOutcome({ kind: "reset" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <DangerZone
        title="Reset every default"
        description="Every review default goes back to the built-in value; projects that set their own keep theirs."
        actionLabel="Reset every default…"
        confirmTitle="Reset every review default?"
        confirmLabel="Yes, reset every default"
        confirmDescription={`Every changed review default of this workspace goes back to the built-in value. Projects with their own values are not touched.${
          kindChange === undefined
            ? ""
            : ` ${followersText(kindChange.to, kindChange.following)}`
        } This cannot be undone.`}
        onConfirm={reset}
      >
        {pending ? <StatusRegion>Resetting the defaults…</StatusRegion> : null}
      </DangerZone>
      {outcome?.kind === "reset" ? (
        <StatusRegion>The defaults are reset.</StatusRegion>
      ) : null}
      {outcome?.kind === "failed" ? (
        <Alert variant="destructive">
          <AlertDescription>{outcome.text}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
