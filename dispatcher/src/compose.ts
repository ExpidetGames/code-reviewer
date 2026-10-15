// SPDX-License-Identifier: Apache-2.0

// What both entry points share: the settings from the environment, the Webhook-Trigger over the
// configured keys and a logger that masks every secret of this deployment.
import { createDispatcher, type Dispatcher } from "./app.ts";
import { loadSettings, type Settings } from "./config.ts";
import { createLogger } from "./core/logger.ts";
import type { Launcher, Logger } from "./core/types.ts";
import type { LauncherContext } from "./launchers/sandbox-env.ts";
import { webhookTrigger } from "./triggers/webhook.ts";

export type ComposeOptions = {
  env: Readonly<Record<string, string | undefined>>;
  /** A Launcher, or how to make one once the settings, the logger and the background tracker exist. */
  launcher: Launcher | ((context: LauncherContext) => Launcher);
  /** Secrets of the launcher's own configuration (a platform token), masked in every log line next to the core's. */
  secrets?: readonly string[];
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
      [
        settings.core.token,
        ...settings.signingKeys.map((key) => key.secret),
        ...(options.secrets ?? []),
      ],
    );
  const launcher =
    typeof options.launcher === "function"
      ? options.launcher({
          settings,
          logger,
          background: options.background,
        })
      : options.launcher;
  const dispatcher = createDispatcher({
    settings: settings.core,
    launcher,
    background: options.background,
    trigger: webhookTrigger({ keys: settings.signingKeys }),
    logger,
    fetch: options.fetch,
  });
  return { ...dispatcher, settings, logger };
}
