// SPDX-License-Identifier: Apache-2.0

// When the reconciler of the check runs runs on a long-lived server (#405-T33): in production at the start and at
// every interval, never elsewhere, one run at a time, and a failing run is logged by its code and does not stop the
// timer. A hosted (serverless) deployment has no timer: its sweep and its requests do this work.
import { describe, expect, it, vi } from "vitest";
import {
  CHECK_RECONCILE_INTERVAL_MS,
  startCheckReconciler,
  startCheckReconcilerOnStart,
} from "./startup.ts";

function fixture(reconcile: () => Promise<{ synced: number }>) {
  let fire: () => void = () => undefined;
  const stopped = vi.fn();
  const setTimer = vi.fn((callback: () => void) => {
    fire = callback;
    return stopped;
  });
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    service: { reconcileDue: vi.fn(reconcile) },
    setTimer,
    log,
    tick: () => fire(),
    stopped,
  };
}

describe("the check run reconciler of a long-lived server", () => {
  // #405-T33
  it("runs once at the start and then at every tick, every minute", async () => {
    const f = fixture(() => Promise.resolve({ synced: 0 }));

    startCheckReconciler(f);
    await vi.waitFor(() =>
      expect(f.service.reconcileDue).toHaveBeenCalledTimes(1),
    );
    f.tick();
    await vi.waitFor(() =>
      expect(f.service.reconcileDue).toHaveBeenCalledTimes(2),
    );

    expect(f.setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      CHECK_RECONCILE_INTERVAL_MS,
    );
    expect(CHECK_RECONCILE_INTERVAL_MS).toBe(60 * 1000);
  });

  // #405-T33
  it("does not start a run while the one before it is still working", async () => {
    let finish: () => void = () => undefined;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ synced: 1 });
        }),
    );

    startCheckReconciler(f);
    await vi.waitFor(() =>
      expect(f.service.reconcileDue).toHaveBeenCalledTimes(1),
    );
    f.tick();
    f.tick();
    expect(f.service.reconcileDue).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(f.log.info).toHaveBeenCalled());
    f.tick();
    await vi.waitFor(() =>
      expect(f.service.reconcileDue).toHaveBeenCalledTimes(2),
    );
  });

  it("says how many jobs it synced, and says nothing when there were none", async () => {
    const some = fixture(() => Promise.resolve({ synced: 2 }));
    const none = fixture(() => Promise.resolve({ synced: 0 }));

    startCheckReconciler(some);
    startCheckReconciler(none);
    await vi.waitFor(() =>
      expect(some.service.reconcileDue).toHaveBeenCalled(),
    );
    await vi.waitFor(() =>
      expect(none.service.reconcileDue).toHaveBeenCalled(),
    );

    await vi.waitFor(() => expect(some.log.info).toHaveBeenCalledTimes(1));
    expect(none.log.info).not.toHaveBeenCalled();
  });

  it("logs a failed run by its code, tries again at the next tick and never stops", async () => {
    const f = fixture(() =>
      Promise.reject(new Error("postgres://u:hunter2@db/app")),
    );

    startCheckReconciler(f);
    await vi.waitFor(() => expect(f.log.error).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(f.log.error).toHaveBeenCalledTimes(2));

    expect(f.log.error).toHaveBeenCalledWith(
      "[check-runs] CHECK_RUN_RECONCILE_FAILED: the check runs could not be reconciled; trying again.",
    );
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain("hunter2");
  });

  it("returns the way to stop it", () => {
    const f = fixture(() => Promise.resolve({ synced: 0 }));

    startCheckReconciler(f).stop();

    expect(f.stopped).toHaveBeenCalledOnce();
  });

  // #405-T33
  it("runs in production only", () => {
    const f = fixture(() => Promise.resolve({ synced: 0 }));

    expect(
      startCheckReconcilerOnStart({ env: { NODE_ENV: "development" }, ...f }),
    ).toBeNull();
    expect(
      startCheckReconcilerOnStart({ env: { NODE_ENV: "test" }, ...f }),
    ).toBeNull();
    expect(f.setTimer).not.toHaveBeenCalled();
    expect(
      startCheckReconcilerOnStart({ env: { NODE_ENV: "production" }, ...f }),
    ).not.toBeNull();
    expect(f.setTimer).toHaveBeenCalledOnce();
  });
});
