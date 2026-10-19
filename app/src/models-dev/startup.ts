// SPDX-License-Identifier: Apache-2.0

// What a long-lived server (Docker Compose, Coolify, a process) does about the models.dev catalog (#548): ask the service
// at the start and then every hour whether a fetch is due. The service keeps the day (the last success is in the database),
// so a restart or a second instance does not fetch again. Called from `src/instrumentation.ts`. A hosted deployment has no
// timer: the sweep asks (src/dispatch/sweep.ts). Other environments (the dev server, tests) run no timer, and an instance
// with `MODELS_DEV_FETCH=off` runs none either. A failing run is logged by its code and tried again at the next tick; it
// never stops the app, and one run never overlaps another.
import "server-only";
import { loadModelsDevSettings } from "./settings.ts";
import type { ModelsDevService } from "./service.ts";
import { getModelsDevService } from "./shared.ts";

export const MODELS_DEV_TICK_MS = 60 * 60 * 1000;

export type ModelsDevTimer = { stop: () => void };

type StartOptions = {
  service?: Pick<ModelsDevService, "refreshIfDue">;
  /** Calls `callback` every `intervalMs`; returns a function that cancels it. */
  setTimer?: (callback: () => void, intervalMs: number) => () => void;
};

function defaultSetTimer(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  // A timer must not keep the process alive.
  timer.unref();
  return () => clearInterval(timer);
}

/** Asks now and again at every interval. */
export function startModelsDevRefresh({
  service,
  setTimer = defaultSetTimer,
}: StartOptions = {}): ModelsDevTimer {
  let running = false;
  const once = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await (service ?? getModelsDevService()).refreshIfDue();
    } catch {
      // Nothing a database or an upstream said is logged: a connection string can be in it.
      console.error(
        "[models-dev] MODELS_DEV_REFRESH_FAILED: the catalog could not be refreshed; trying again at the next tick.",
      );
    } finally {
      running = false;
    }
  };
  void once();
  return { stop: setTimer(() => void once(), MODELS_DEV_TICK_MS) };
}

export function startModelsDevRefreshOnStart({
  env = process.env,
  ...options
}: StartOptions & {
  env?: Readonly<Record<string, string | undefined>>;
} = {}): ModelsDevTimer | null {
  if (env.NODE_ENV !== "production") return null;
  const settings = loadModelsDevSettings(env);
  for (const warning of settings.warnings)
    console.warn(`[models-dev] ${warning}: MODELS_DEV_URL is not an http or https address without credentials; the default is used.`);
  if (!settings.enabled) {
    console.info("[models-dev] MODELS_DEV_FETCH is off: the catalog is not fetched.");
    return null;
  }
  return startModelsDevRefresh(options);
}
