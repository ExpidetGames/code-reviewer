// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The status of a run as a quiet badge: the label as text, a symbol of its own and a soft tone per
// status, so the status is never told by colour alone. The symbol is a Phosphor icon (#636), hidden
// from assistive technology: the label is the accessible name of the status and is read once. The full description is not printed next to the label;
// on the run detail page `hint` adds the focusable "?" that holds it.
import { Badge } from "../../components/ui/badge.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import type { JobStatus } from "../../db/job-status.ts";
import {
  ArrowClockwiseIcon,
  CheckIcon,
  HourglassIcon,
  PlayIcon,
  ProhibitIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";
import type { Icon } from "@phosphor-icons/react";
import {
  RUN_STATUS_PRESENTATION,
  type RunStatusSymbol,
} from "../run-status.ts";

/** The Phosphor icon behind each status symbol (the design board's run badges). */
const SYMBOL_ICON: Record<RunStatusSymbol, Icon> = {
  hourglass: HourglassIcon,
  play: PlayIcon,
  check: CheckIcon,
  x: XIcon,
  prohibit: ProhibitIcon,
  "arrow-clockwise": ArrowClockwiseIcon,
};

/** One soft tone per status; the meaning stays in the label, the tone is only a hint. */
const STATUS_TONE: Record<
  JobStatus,
  "running" | "success" | "danger" | "neutral"
> = {
  // The design board's run badges (#633): waiting on raised, running and succeeded outlined in fg,
  // failed filled in fg, cancelled and superseded on raised.
  queued: "neutral",
  running: "running",
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
  const StatusIcon = SYMBOL_ICON[presentation.symbol];
  const badge = (
    // The description is reachable without a second control per row: a non-interactive `title` on the
    // list badge, and the focusable "?" (`hint`) on the run detail.
    <Badge
      variant={STATUS_TONE[status]}
      icon={false}
      data-status={status}
      title={presentation.description}
    >
      <StatusIcon aria-hidden="true" weight="bold" />
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
