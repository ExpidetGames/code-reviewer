// SPDX-License-Identifier: LicenseRef-Proprietary

// The refusals of a claim, gathered before anything is scheduled (#281). A claim can refuse a whole backlog (a
// suspension fails every due job of the workspace), and one callback per job would be a callback per job after the
// response. Here the refusals of one pull request and period become one, and the first of a batch schedules one
// callback that handles them all, one after the other, once the response is on its way. A callback that is cut off
// part-way (a serverless function can be) leaves the pull requests it did not reach without a row: a notice is best
// effort, and the next refusal on those pull requests tries again.
import type { NoticeRefusal } from "./service.ts";

export type RefusalBatcherOptions = {
  /** Runs the work after the response (`after()` in the app). May throw outside a request; the batcher copes. */
  schedule: (work: () => Promise<void>) => void;
  /** Handles one refusal; never rejects. */
  handle: (refusal: NoticeRefusal) => Promise<void>;
};

export type RefusalBatcher = {
  /** Never throws. */
  add(refusal: NoticeRefusal): void;
};

function keyOf(refusal: NoticeRefusal): string {
  return JSON.stringify([
    refusal.workspaceId,
    refusal.repositoryId,
    refusal.prNumber,
    refusal.periodStart,
  ]);
}

export function createRefusalBatcher(
  options: RefusalBatcherOptions,
): RefusalBatcher {
  let pending = new Map<string, NoticeRefusal>();

  async function flush(): Promise<void> {
    const batch = pending;
    pending = new Map();
    for (const refusal of batch.values()) await options.handle(refusal);
  }

  return {
    add(refusal) {
      const key = keyOf(refusal);
      const known = pending.get(key);
      // A review somebody asked for is allowed to announce itself on a draft; an automatic one is not.
      if (known !== undefined && known.triggerKind !== "webhook") return;
      const first = pending.size === 0;
      pending.set(key, refusal);
      if (!first) return;
      try {
        options.schedule(flush);
      } catch {
        // Nothing to schedule on: drop the batch, the claim must not notice.
        pending = new Map();
      }
    },
  };
}
