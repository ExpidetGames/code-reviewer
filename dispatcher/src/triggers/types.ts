// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Hono } from "hono";
import type { DispatcherCore, Logger } from "../core/types.ts";

/** What the app gives a Trigger to work with. */
export type TriggerContext = {
  core: DispatcherCore;
  /** Hands work to the platform to finish after the answer is sent (`waitUntil`, or the Node tracker). */
  background: (work: Promise<unknown>) => void;
  logger: Logger;
};

/** How the Dispatcher learns about a job. A Trigger mounts its routes on the app and calls `core.handle`. */
export interface Trigger {
  mount(app: Hono, context: TriggerContext): void;
}
