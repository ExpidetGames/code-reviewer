// SPDX-License-Identifier: Apache-2.0

// The measure of a job that has no VM (#493, ADR 0006, 2.11): a self-hosted runner or a Compose stack runs the Worker
// itself, so the time that can be measured is the job's wall clock on a runner, from the claim of the settled attempt to
// its end (`job_wall_clock`). It is recorded only where billing is on (an operator who does not want to charge for it
// sets the rate B to 0), and only for a job that no Dispatcher started: a job with an acknowledged wake-up has a VM and
// is measured by the VM. Best effort and idempotent; nothing here ever throws, and it is a reaction to the end of a claim,
// never a step of it. With billing off it reads the switch and nothing else.
import "server-only";
import type { Kysely } from "kysely";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import type { Database } from "../db/schema.ts";
import { isBillingOn } from "./enabled.ts";

export type WallClockRecorder = {
  /** Records the wall clock of these jobs, whose claims just ended. Never rejects. */
  recordFor(jobIds: readonly string[]): Promise<void>;
};

export function createWallClockRecorder(options: {
  db: Kysely<Database>;
  now?: () => Date;
}): WallClockRecorder {
  const now = options.now ?? (() => new Date());
  const dispatches = createJobDispatchesRepository(options.db, now);

  async function recordOne(jobId: string): Promise<void> {
    // A Dispatcher that acknowledged the job started a VM for it: the VM is the measure.
    if ((await dispatches.get(jobId))?.ackedAt != null) return;
    const workspaceId = await dispatches.workspaceOf(jobId);
    if (workspaceId === undefined) return;
    await createJobVmRunsRepository(
      options.db,
      workspaceId,
      now,
    ).recordWallClock(jobId);
  }

  return {
    async recordFor(jobIds) {
      try {
        if (jobIds.length === 0 || !(await isBillingOn(options.db))) return;
        for (const jobId of new Set(jobIds)) {
          try {
            await recordOne(jobId);
          } catch {
            // Only that it failed: #498 asks for the measure again when it settles, and a job without a row costs 0 minutes.
            console.error(`[billing] WALL_CLOCK_NOT_RECORDED job=${jobId}`);
          }
        }
      } catch {
        console.error("[billing] WALL_CLOCK_NOT_RECORDED");
      }
    },
  };
}
