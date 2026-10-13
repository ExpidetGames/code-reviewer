// SPDX-License-Identifier: Apache-2.0

"use client";
// The status of a run as a quiet badge: the label as text, a symbol of its own and a soft tone per
// status, so the status is never told by colour alone. The symbol is decoration for assistive
// technology (the label carries the meaning). The full description is not printed next to the label;
// on the run detail page `hint` adds the focusable "?" that holds it.
import { Badge } from "../../components/ui/badge.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import type { JobStatus } from "../../jobs/job-status.ts";
import { RUN_STATUS_PRESENTATION } from "../run-status.ts";

/** One soft tone per status; the meaning stays in the label, the tone is only a hint. */
const STATUS_TONE: Record<
  JobStatus,
  "info" | "success" | "danger" | "neutral"
> = {
  queued: "info",
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  superseded: "neutral",
};

export function RunStatusBadge({
  status,
  hint = false,
}: {
  status: JobStatus;
  /** Add the focusable "?" that holds the status description (the run detail page). */
  hint?: boolean;
}) {
  const presentation = RUN_STATUS_PRESENTATION[status];
  const badge = (
    <Badge variant={STATUS_TONE[status]} data-status={status}>
      <span aria-hidden="true">{presentation.symbol}</span>
      {presentation.label}
    </Badge>
  );
  if (!hint) return badge;
  return (
    <span className="inline-flex items-center gap-1">
      {badge}
      <InfoHint label={`About the status ${presentation.label}`}>
        {presentation.description}
      </InfoHint>
    </span>
  );
}
