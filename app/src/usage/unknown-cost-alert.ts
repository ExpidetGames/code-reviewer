// SPDX-License-Identifier: Apache-2.0

// The alert for a run that settled without a known cost (#361). A cost limit adds up known costs only, so such a run
// is not bounded by it; the line is how an operator watches them (`src/usage/README.md`, "Unknown cost"). Pure, so
// what it may say is pinned by a test: the ids of the workspace and the job, never a figure, a model, a key or a name.
import type { UnknownCostSettlement } from "./usage-records.ts";

export function unknownCostAlertLine({
  workspaceId,
  jobId,
}: UnknownCostSettlement): string {
  return `[usage] job=${jobId} workspace=${workspaceId} settled with an unknown cost (not bounded by a cost limit)`;
}
