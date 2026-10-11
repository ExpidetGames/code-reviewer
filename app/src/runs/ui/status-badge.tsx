// SPDX-License-Identifier: Apache-2.0

// The status of a run as a badge: the label as text and a symbol of its own, so the status is never
// told by color alone. The symbol is decoration for assistive technology (the label carries the
// meaning); the description is available as a tooltip.
import type { JobStatus } from "../../jobs/job-status.ts";
import { RUN_STATUS_PRESENTATION } from "../run-status.ts";

export function RunStatusBadge({ status }: { status: JobStatus }) {
  const presentation = RUN_STATUS_PRESENTATION[status];
  return (
    <span
      className={`badge badge-run badge-run-${status}`}
      title={presentation.description}
      data-status={status}
    >
      <span aria-hidden="true">{presentation.symbol}</span>
      {presentation.label}
    </span>
  );
}
