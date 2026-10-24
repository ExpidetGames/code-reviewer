// SPDX-License-Identifier: LicenseRef-Proprietary

// The work that goes on after a Trigger has answered. On the platform this is `waitUntil`; in a Node
// process it is this tracker, which a graceful shutdown waits for.

export type BackgroundTracker = {
  /** Registers a promise; a rejection is swallowed (the core's background work never rejects). */
  run(work: Promise<unknown>): void;
  /** Resolves true when everything registered has finished, false when `timeoutMs` ran out first. */
  drain(timeoutMs: number): Promise<boolean>;
  size(): number;
};

export function createBackgroundTracker(): BackgroundTracker {
  const pending = new Set<Promise<unknown>>();
  return {
    run(work) {
      const tracked = work
        .catch(() => undefined)
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    async drain(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const finished = (async () => {
        while (pending.size > 0) await Promise.all([...pending]);
        return true as const;
      })();
      try {
        return await Promise.race([finished, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
    size: () => pending.size,
  };
}
