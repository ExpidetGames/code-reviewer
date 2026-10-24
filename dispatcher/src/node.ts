// SPDX-License-Identifier: LicenseRef-Proprietary

// The `node` entry: the same Dispatcher as a Node process (@hono/node-server) with a graceful shutdown.
// The Docker-Launcher (#334) is wired in here; until then `noLauncher` advertises no engine. Run it with
// `pnpm start` (Node strips the types). On SIGTERM or SIGINT the server stops accepting calls, the launches
// in progress get DISPATCHER_SHUTDOWN_GRACE_SECONDS to hand their Workers over, and what is still running
// after that is stopped and its job released.
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createBackgroundTracker } from "./background.ts";
import { composeDispatcher } from "./compose.ts";
import type { Launcher, Logger } from "./core/types.ts";
import { noLauncher } from "./launchers/none.ts";
import type { ReaperSetup } from "./launchers/sandbox-env.ts";
import type { Settings } from "./config.ts";

export type NodeServerOptions = {
  env: Readonly<Record<string, string | undefined>>;
  launcher: Launcher;
  /** 0 picks a free port; the default is PORT or 8080. */
  port?: number;
  hostname?: string;
  logger?: Logger;
  /** The platform's fleet (#364, #487): with it the entry serves the reaper's cron route and the App's `POST /stop`. */
  reaper?: (settings: Settings) => ReaperSetup;
};

export type NodeServer = {
  port: number;
  /** Idempotent. Resolves when the server is closed and no launch is left. */
  shutdown(): Promise<void>;
};

export async function startNodeServer(
  options: NodeServerOptions,
): Promise<NodeServer> {
  const background = createBackgroundTracker();
  const { app, core, settings, logger } = composeDispatcher({
    env: options.env,
    launcher: options.launcher,
    background: background.run,
    logger: options.logger,
    ...(options.reaper === undefined ? {} : { reaper: options.reaper }),
  });
  const port = options.port ?? (Number(options.env.PORT) || 8080);
  const server: ServerType = await new Promise((resolve) => {
    const started = serve(
      { fetch: app.fetch, port, hostname: options.hostname ?? "0.0.0.0" },
      () => resolve(started),
    );
  });
  const address = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    logger.info("shutdown_started", { launches: background.size() });
    // Stop accepting new calls; connections that are idle are closed, a call being answered finishes.
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    const finished = await background.drain(
      settings.shutdownGraceSeconds * 1000,
    );
    if (!finished) {
      logger.warn("shutdown_grace_over", { launches: background.size() });
      core.abort();
      await background.drain(30_000);
    }
    if ("closeAllConnections" in server) server.closeAllConnections();
    await closed;
    logger.info("shutdown_done");
  }

  return {
    port: address.port,
    shutdown() {
      closing ??= close();
      return closing;
    },
  };
}

// Runs only when started as the program, not when a test imports `startNodeServer`.
if (import.meta.main) {
  const server = await startNodeServer({
    env: process.env,
    launcher: noLauncher,
  });
  console.log(
    JSON.stringify({ level: "info", event: "listening", port: server.port }),
  );
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void server.shutdown().then(() => process.exit(0));
    });
}
