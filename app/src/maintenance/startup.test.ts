// SPDX-License-Identifier: Apache-2.0

// Pins down when the cleanup runs: in production at the start and at every interval, never elsewhere, and a
// failing run is logged by its code and does not stop the timer.
import { describe, expect, it, vi } from "vitest";
import {
  CLEANUP_INTERVAL_MS,
  startCleanup,
  startCleanupOnStart,
} from "./startup.ts";

function fixture(
  run: () => Promise<{ rateLimits: number; verificationTokens: number }>,
) {
  let fire: () => void = () => undefined;
  const stopped = vi.fn();
  const setTimer = vi.fn((callback: () => void) => {
    fire = callback;
    return stopped;
  });
  const log = { info: vi.fn(), error: vi.fn() };
  return { run: vi.fn(run), setTimer, log, tick: () => fire(), stopped };
}

describe("the cleanup timer", () => {
  it("runs once at the start and then at every tick, every hour", async () => {
    const f = fixture(() =>
      Promise.resolve({ rateLimits: 0, verificationTokens: 0 }),
    );

    startCleanup(f);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));

    expect(f.setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      CLEANUP_INTERVAL_MS,
    );
    expect(CLEANUP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("says how many rows it removed, and says nothing when there were none", async () => {
    const some = fixture(() =>
      Promise.resolve({ rateLimits: 3, verificationTokens: 1 }),
    );
    const none = fixture(() =>
      Promise.resolve({ rateLimits: 0, verificationTokens: 0 }),
    );

    startCleanup(some);
    startCleanup(none);
    await vi.waitFor(() => expect(some.log.info).toHaveBeenCalledTimes(1));

    expect(String(some.log.info.mock.calls[0]?.[0])).toContain(
      "3 old rate limit counters and 1 old verification links",
    );
    expect(none.log.info).not.toHaveBeenCalled();
  });

  it("logs a failure by its code, keeps the timer and tries again", async () => {
    let calls = 0;
    const f = fixture(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("secret detail"))
        : Promise.resolve({ rateLimits: 0, verificationTokens: 0 });
    });

    startCleanup(f);
    await vi.waitFor(() => expect(f.log.error).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));

    expect(String(f.log.error.mock.calls[0]?.[0])).toContain("CLEANUP_FAILED");
    expect(String(f.log.error.mock.calls[0]?.[0])).not.toContain(
      "secret detail",
    );
  });

  it("stops the timer", () => {
    const f = fixture(() =>
      Promise.resolve({ rateLimits: 0, verificationTokens: 0 }),
    );

    startCleanup(f).stop();

    expect(f.stopped).toHaveBeenCalledTimes(1);
  });

  it("runs only in production", () => {
    const f = fixture(() =>
      Promise.resolve({ rateLimits: 0, verificationTokens: 0 }),
    );

    expect(
      startCleanupOnStart({ env: { NODE_ENV: "development" }, ...f }),
    ).toBeNull();
    expect(startCleanupOnStart({ env: {}, ...f })).toBeNull();
    expect(f.setTimer).not.toHaveBeenCalled();
    expect(
      startCleanupOnStart({ env: { NODE_ENV: "production" }, ...f }),
    ).not.toBeNull();
    expect(f.setTimer).toHaveBeenCalledTimes(1);
  });
});
