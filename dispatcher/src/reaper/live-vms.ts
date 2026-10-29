// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher's own count of the job VMs that are up, per app (#730): one listing of the project's VMs, each checked with
// the reaper's rule (`shapeOf`) and counted for the app its `tenant` tag names (no tag: `reviewer`). A canary, a golden
// builder, a lookalike and a VM the platform is already ending are not counted. The core reuses the answer for a few seconds.
import type { LiveVmCounter } from "../core/types.ts";
import type { SandboxFleet } from "../launchers/sandbox-service.ts";
import { APP_TAG, NAME_PREFIX, isLive, shapeOf } from "./vm-shape.ts";

export function liveJobVmsByApp(
  fleet: Pick<SandboxFleet, "list">,
): LiveVmCounter {
  return async (signal) => {
    const listed = await fleet.list(
      { namePrefix: NAME_PREFIX, tags: { app: APP_TAG } },
      signal,
    );
    const counts = new Map<string, number>();
    for (const vm of listed) {
      const shape = shapeOf(vm);
      if (shape?.kind !== "job" || !isLive(vm)) continue;
      counts.set(shape.appId, (counts.get(shape.appId) ?? 0) + 1);
    }
    return counts;
  };
}
