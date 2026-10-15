// SPDX-License-Identifier: Apache-2.0

// What both entry points share: the settings from the environment, the Webhook-Trigger over the
// configured keys and a logger that masks every secret of this deployment.
import { createDispatcher, type Dispatcher } from "./app.ts";
import { loadSettings, type Settings } from "./config.ts";
import { createLogger } from "./core/logger.ts";
import type { Launcher, Logger } from "./core/types.ts";
import { webhookTrigger } from "./triggers/webhook.ts";

export type ComposeOptions = {
  env: Readonly<Record<string, string | undefined>>;
  launcher: Launcher;
  /** `waitUntil` on the platform, the tracker of the Node entry. */
  background: (work: Promise<unknown>) => void;
  logger?: Logger;
  fetch?: typeof fetch;
};

export function composeDispatcher(
  options: ComposeOptions,
): Dispatcher & { settings: Settings; logger: Logger } {
  const settings = loadSettings(options.env);
  const logger =
    options.logger ??
    createLogger(
      (line) => console.log(line),
      [settings.core.token, ...settings.signingKeys.map((key) => key.secret)],
    );
  const dispatcher = createDispatcher({
    settings: settings.core,
    launcher: options.launcher,
    background: options.background,
    trigger: webhookTrigger({ keys: settings.signingKeys }),
    logger,
    fetch: options.fetch,
  });
  return { ...dispatcher, settings, logger };
}
