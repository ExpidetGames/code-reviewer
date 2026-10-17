// SPDX-License-Identifier: Apache-2.0

// What both entry points share: the settings from the environment, the Webhook-Trigger over the
// configured keys and a logger that masks every secret of this deployment.
import { createDispatcher, type Dispatcher } from "./dispatcher-app.ts";
import { loadSettings, type Settings } from "./config.ts";
import { createLogger } from "./core/logger.ts";
import type { Launcher, Logger } from "./core/types.ts";
import type { LauncherContext, ReaperSetup } from "./launchers/sandbox-env.ts";
import { createAppClient } from "./core/app-client.ts";
import { createReaper } from "./reaper/reaper.ts";
import { mountReaperRoute } from "./reaper/route.ts";
import { webhookTrigger } from "./triggers/webhook.ts";

export type ComposeOptions = {
  env: Readonly<Record<string, string | undefined>>;
  /** A Launcher, or how to make one once the settings, the logger and the background tracker exist. */
  launcher: Launcher | ((context: LauncherContext) => Launcher);
  /** Secrets of the launcher's own configuration (a platform token), masked in every log line next to the core's. */
  secrets?: readonly string[];
  /** `waitUntil` on the platform, the tracker of the Node entry. */
  background: (work: Promise<unknown>) => void;
  /** The reaper's platform side (#364): its cron route is mounted when there is one. */
  reaper?: (settings: Settings) => ReaperSetup;
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
        ...(settings.cronSecret === undefined ? [] : [settings.cronSecret]),
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
    ...(options.env.SANDBOX_IMAGE_DIGEST === undefined
      ? {}
      : { imageDigest: options.env.SANDBOX_IMAGE_DIGEST }),
    ...(options.env.SANDBOX_SNAPSHOT_ID === undefined
      ? {}
      : { snapshotId: options.env.SANDBOX_SNAPSHOT_ID }),
  });
  // A malformed CRON_SECRET matters only where the route exists: there it refuses the start (fail closed), elsewhere
  // a Dispatcher that never reaps is not taken down by a variable it does not use.
  if (settings.cronSecretProblem !== undefined) {
    if (options.reaper !== undefined) throw settings.cronSecretProblem;
    logger.warn("cron_secret_ignored", {
      variable: settings.cronSecretProblem.variable,
      reason: settings.cronSecretProblem.reason,
    });
  }
  if (options.reaper !== undefined) {
    const setup = options.reaper(settings);
    const client = createAppClient({
      appUrl: settings.core.appUrl,
      token: settings.core.token,
      poolId: settings.core.poolId,
      fetch: options.fetch ?? fetch,
    });
    mountReaperRoute(dispatcher.app, {
      cronSecret: settings.cronSecret,
      reaper: createReaper({
        fleet: setup.fleet,
        jobs: client,
        logger,
        jobLifetimeSeconds: setup.jobLifetimeSeconds,
        canaryLifetimeSeconds: setup.canaryLifetimeSeconds,
      }),
      logger,
    });
    // Without it the route refuses everyone and leftover VMs are billed until their own timeout.
    if (settings.cronSecret === undefined)
      logger.warn("reaper_cron_secret_missing");
  }
  return { ...dispatcher, settings, logger };
}
