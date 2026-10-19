// SPDX-License-Identifier: Apache-2.0

// Replay protection of the stop call (#487): the stop ids this instance has handled. A stop id is new for every stop,
// and a call older than the clock window is refused before it gets here, so an id is remembered for twice the window.
// The memory is the instance's own: another instance of the Dispatcher does not know it. That is accepted because a
// stop is idempotent and only ever ends VMs of one job; the id closes the replay of one captured call against the
// instance that handled it. Only an id of a call that was verified is ever put here, so a caller without the key cannot
// fill it or use up the id of a real call.

/** Twice the clock window (300 seconds either way). */
export const REPLAY_TTL_MS = 600_000;
/** More than the Dispatcher could be asked to stop within the window; the oldest go first. */
export const REPLAY_MAX_IDS = 10_000;

export type ReplayGuard = {
  /** True when the id is new (and now remembered); false when it was handled, or is being handled. */
  begin(id: string): boolean;
  /** Takes an id back, so that the same call can be repeated: the work behind it could not be done. */
  forget(id: string): void;
};

export function createReplayGuard(
  options: { now?: () => number; ttlMs?: number; maxIds?: number } = {},
): ReplayGuard {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? REPLAY_TTL_MS;
  const maxIds = options.maxIds ?? REPLAY_MAX_IDS;
  /** Insertion order is expiry order, as every id is remembered for the same time. */
  const seen = new Map<string, number>();

  function prune(at: number): void {
    for (const [id, until] of seen) {
      if (until > at) break;
      seen.delete(id);
    }
    while (seen.size >= maxIds) {
      const oldest = seen.keys().next();
      if (oldest.done === true) break;
      seen.delete(oldest.value);
    }
  }

  return {
    begin(id) {
      const at = now();
      prune(at);
      if (seen.has(id)) return false;
      seen.set(id, at + ttlMs);
      return true;
    },
    forget(id) {
      seen.delete(id);
    },
  };
}
