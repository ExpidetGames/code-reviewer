// SPDX-License-Identifier: LicenseRef-Proprietary

/** Waits for a condition, looking every 100 ms; fails with `what` when it does not hold in time. */
export async function waitUntil(
  what: string,
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${what}.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
