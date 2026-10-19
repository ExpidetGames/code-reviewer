// SPDX-License-Identifier: Apache-2.0

// When the daily models.dev fetch runs on a long-lived server (#548): in production at the start and at every tick,
// one run at a time, never elsewhere; a failing run is logged by its code and does not stop the timer. The service decides
// whether a fetch is due, so a restart does not fetch again. A hosted (serverless) deployment has no timer: its sweep does
// this work.
import { describe, expect, it, vi } from "vitest";
import type { RefreshOutcome } from "./service.ts";
import {
  MODELS_DEV_TICK_MS,
  startModelsDevRefresh,
  startModelsDevRefreshOnStart,
} from "./startup.ts";

function fixture(refresh: () => Promise<RefreshOutcome>) {
  let fire: () => void = () => undefined;
  const stopped = vi.fn();
  const setTimer = vi.fn((callback: () => void) => {
    fire = callback;
    return stopped;
  });
  return {
    service: { refreshIfDue: vi.fn(refresh) },
    setTimer,
    tick: () => fire(),
    stopped,
  };
}
const skipped = (): Promise<RefreshOutcome> => Promise.resolve({ status: "skipped", reason: "not_due" });

describe("the models.dev fetch of a long-lived server", () => {
  // #548-T03
  it("asks the service once at the start and then every hour, and the service decides whether a fetch is due", async () => {
    const f = fixture(skipped);

    startModelsDevRefresh(f);
    await vi.waitFor(() => expect(f.service.refreshIfDue).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(f.service.refreshIfDue).toHaveBeenCalledTimes(2));

    expect(f.setTimer).toHaveBeenCalledWith(expect.any(Function), MODELS_DEV_TICK_MS);
    expect(MODELS_DEV_TICK_MS).toBe(60 * 60 * 1000);
  });

  // #548-T03
  it("does not start a run while the one before it is still working", async () => {
    let finish: () => void = () => undefined;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: "skipped", reason: "not_due" });
        }),
    );

    startModelsDevRefresh(f);
    await vi.waitFor(() => expect(f.service.refreshIfDue).toHaveBeenCalledTimes(1));
    f.tick();
    f.tick();
    expect(f.service.refreshIfDue).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => undefined);
    f.tick();
    await vi.waitFor(() => expect(f.service.refreshIfDue).toHaveBeenCalledTimes(2));
  });

  // #548-T04
  it("logs a run that threw by a code, tries again at the next tick and never stops", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture(() => Promise.reject(new Error("postgres://u:hunter2@db/app")));

    startModelsDevRefresh(f);
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    f.tick();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));

    expect(String(error.mock.calls[0]?.[0])).toContain("MODELS_DEV_REFRESH_FAILED");
    expect(JSON.stringify(error.mock.calls)).not.toContain("hunter2");
  });

  it("returns the way to stop it", () => {
    const f = fixture(skipped);

    startModelsDevRefresh(f).stop();

    expect(f.stopped).toHaveBeenCalledOnce();
  });

  // #548-T13
  it("runs in production only", () => {
    const f = fixture(skipped);

    expect(startModelsDevRefreshOnStart({ env: { NODE_ENV: "development" }, ...f })).toBeNull();
    expect(startModelsDevRefreshOnStart({ env: { NODE_ENV: "test" }, ...f })).toBeNull();
    expect(f.setTimer).not.toHaveBeenCalled();
    expect(startModelsDevRefreshOnStart({ env: { NODE_ENV: "production" }, ...f })).not.toBeNull();
    expect(f.setTimer).toHaveBeenCalledOnce();
  });

  // #548-T13
  it("starts no timer at all when the fetch is switched off", () => {
    const f = fixture(skipped);

    const timer = startModelsDevRefreshOnStart({
      env: { NODE_ENV: "production", MODELS_DEV_FETCH: "off" },
      ...f,
    });

    expect(timer).toBeNull();
    expect(f.setTimer).not.toHaveBeenCalled();
    expect(f.service.refreshIfDue).not.toHaveBeenCalled();
  });
});
