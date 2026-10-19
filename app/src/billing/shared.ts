// SPDX-License-Identifier: Apache-2.0

// The billing measures of the running server (#493): what the queue reports when a claim ended, handed to the platform to
// run after the response like every other reaction (src/dispatch/shared.ts). Never throws, never delays the call.
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { createWallClockRecorder } from "./wall-clock.ts";

/** The claims of these jobs ended: records the wall clock of those that ran on a runner, where billing is on. */
export function recordWallClocks(jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  try {
    const recorder = createWallClockRecorder({ db: getDatabase() });
    runAfterResponse(() => recorder.recordFor(jobIds));
  } catch {
    console.error("[billing] WALL_CLOCK_NOT_RECORDED");
  }
}
