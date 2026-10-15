// SPDX-License-Identifier: Apache-2.0

// The `vercel` entry: Vercel builds a Hono app from a default export of this file with no further
// configuration. The Sandbox-Launcher (#329) replaces `noLauncher` here; until then no engine is
// advertised and every wake-up call is ignored. This file and what it imports must never reach
// `node:child_process` (the Node entry, node.ts, is a separate file for that reason; see
// src/build/serverless-bundle.test.ts).
import { waitUntil } from "@vercel/functions";
import { composeDispatcher } from "./compose.ts";
import { noLauncher } from "./launchers/none.ts";

const { app } = composeDispatcher({
  env: process.env,
  launcher: noLauncher,
  background: (work) => waitUntil(work),
});

export default app;
