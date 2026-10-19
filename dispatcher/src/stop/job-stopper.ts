// SPDX-License-Identifier: Apache-2.0

// Finds the VMs of one job (#487). The App tells the Dispatcher that a job's claim has ended; the Dispatcher stops the
// VMs it created for that job and nothing else. The job id is a UUID the route has already validated, and it is used
// only inside a name prefix of our own naming scheme (`cr-<kind>-<job id>-`, launchers/sandbox.ts) together with the tag
// the Launcher puts on every VM. The platform's listing only narrows: every VM it returns is checked again with the
// reaper's rule (`shapeOf`), so a VM that is not exactly one of our job VMs of this job, a canary, a persistent VM,
// a lookalike or one the platform is already ending is never returned.
import type { SandboxFleet } from "../launchers/sandbox-service.ts";
import { APP_TAG, isLive, shapeOf } from "../reaper/vm-shape.ts";

const KINDS = ["diff", "dynamic"] as const;

export class StopLookupError extends Error {
  readonly code = "STOP_LIST_FAILED";

  constructor() {
    super("STOP_LIST_FAILED");
    this.name = "StopLookupError";
  }
}

/** The names of the live VMs of `jobId` that this Dispatcher's Launcher could have created. */
export async function findJobVms(
  fleet: Pick<SandboxFleet, "list">,
  jobId: string,
): Promise<string[]> {
  const id = jobId.toLowerCase();
  const names = new Set<string>();
  try {
    for (const kind of KINDS) {
      const listed = await fleet.list({
        namePrefix: `cr-${kind}-${id}-`,
        tags: { app: APP_TAG },
      });
      for (const vm of listed) {
        const shape = shapeOf(vm);
        if (
          shape?.kind === "job" &&
          shape.jobId === id &&
          vm.tags.kind === kind &&
          isLive(vm)
        )
          names.add(vm.name);
      }
    }
  } catch {
    // The platform's own text is not ours to keep.
    throw new StopLookupError();
  }
  return [...names];
}
