// SPDX-License-Identifier: LicenseRef-Proprietary

// A clock a test moves by hand: `sleep` resolves when `advance` has moved time far enough, or when its
// signal aborts. Nothing here reads the real time, so a five minute deadline takes no time in a test.
import type { Clock } from "../core/types.ts";

type Sleeper = { due: number; resolve: () => void };

export class ManualClock implements Clock {
  private current = 0;
  private sleepers: Sleeper[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const sleeper: Sleeper = { due: this.current + ms, resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.sleepers = this.sleepers.filter((other) => other !== sleeper);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Moves time forward, waking the sleepers in the order they are due, one step at a time. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const next = this.sleepers
        .filter((sleeper) => sleeper.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      this.sleepers = this.sleepers.filter((other) => other !== next);
      this.current = Math.max(this.current, next.due);
      next.resolve();
      await settle();
    }
    this.current = target;
  }

  /** How many sleeps are waiting. */
  pending(): number {
    return this.sleepers.length;
  }
}

/** Lets the promise callbacks and the loopback I/O that a woken sleeper started run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}
