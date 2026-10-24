// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Clock } from "./types.ts";

/** The real clock: a timer, cleared when the signal aborts. */
export const systemClock: Clock = {
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
