// SPDX-License-Identifier: Apache-2.0

// The `vercel` entry: Vercel builds a Hono app from a default export of this file with no further
// configuration. The Launcher is the Sandbox-Launcher (#329) when a golden snapshot is configured
// (SANDBOX_SNAPSHOT_ID, see launchers/sandbox-env.ts); without one it is `noLauncher`, which advertises no
// engine, so every wake-up call is ignored. The Sandbox SDK is loaded on the first job, not at start. This file
// and what it imports must never reach `node:child_process` (the Node entry, node.ts, is a separate file for
// that reason; see src/bundle/serverless-bundle.test.ts).
import { waitUntil } from "@vercel/functions";
import { composeDispatcher } from "./compose.ts";
import { sandboxFromEnvironment } from "./launchers/sandbox-env.ts";

const sandbox = sandboxFromEnvironment(
  process.env,
  () => import("@vercel/sandbox"),
);

const { app } = composeDispatcher({
  env: process.env,
  launcher: sandbox.launcher,
  secrets: sandbox.secrets,
  background: (work) => waitUntil(work),
});

export default app;
