// SPDX-License-Identifier: Apache-2.0

// Puts the Dispatcher together: the core (over a Launcher), one Trigger and GET /health on a Hono app.
// Nothing here knows the platform: the entry points (index.ts for Vercel, node.ts for a Node process)
// choose the Launcher and say how background work is kept alive.
import { Hono } from "hono";
import { createLogger } from "./core/logger.ts";
import { createDispatcherCore } from "./core/dispatcher.ts";
import type {
  Clock,
  CoreSettings,
  DispatcherCore,
  Launcher,
  Logger,
} from "./core/types.ts";
import { mountProbeRoute } from "./probe/route.ts";
import type { Trigger } from "./triggers/types.ts";

export type AppOptions = {
  settings: CoreSettings;
  trigger: Trigger;
  launcher: Launcher;
  /** Keeps the launch going after the answer is sent: `waitUntil` on the platform. */
  background: (work: Promise<unknown>) => void;
  logger?: Logger;
  fetch?: typeof fetch;
  clock?: Clock;
  /** The Worker image id of the golden snapshot (`SANDBOX_IMAGE_DIGEST`): named in the answer of `POST /probe`. */
  imageDigest?: string;
};

export type Dispatcher = { app: Hono; core: DispatcherCore };

export function createDispatcher(options: AppOptions): Dispatcher {
  const logger =
    options.logger ??
    createLogger((line) => console.log(line), [options.settings.token]);
  const core = createDispatcherCore({
    settings: options.settings,
    launcher: options.launcher,
    logger,
    fetch: options.fetch,
    clock: options.clock,
  });
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  options.trigger.mount(app, { core, background: options.background, logger });
  mountProbeRoute(app, {
    token: options.settings.token,
    engines: options.settings.engines,
    launcher: options.launcher,
    logger,
    ...(options.imageDigest === undefined
      ? {}
      : { imageDigest: options.imageDigest }),
  });
  app.onError((_error, c) => {
    // The error is not logged with its text: it may carry what a caller sent.
    logger.error("unhandled_error");
    return c.json(
      {
        error: {
          code: "RUNNER_INTERNAL_ERROR",
          message: "The request could not be handled.",
        },
      },
      500,
    );
  });
  return { app, core };
}

/** `createApp({ trigger, launcher })` of the design: the Hono app of a Dispatcher. */
export function createApp(options: AppOptions): Hono {
  return createDispatcher(options).app;
}
