// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server for the plan page (#282): the real database and the real clock. Pages and the
// polling route ask for the view of one workspace here; tests call `readPlanView` with their own database.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import type { PlanView } from "./plan-view.ts";
import { planPageAvailable, readPlanView } from "./usage-summary.ts";

/** What the plan page shows for one workspace. */
export function planViewFor(workspaceId: string): Promise<PlanView> {
  return readPlanView(getDatabase(), workspaceId);
}

/** Whether the settings navigation of the workspace links to the plan page. */
export function planPageLinkedFor(workspaceId: string): Promise<boolean> {
  return planPageAvailable(getDatabase(), workspaceId);
}
