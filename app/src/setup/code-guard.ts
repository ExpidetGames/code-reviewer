// SPDX-License-Identifier: Apache-2.0

// Which setup code store the running app uses (#321). A server keeps the code in the memory of its one
// process, as it always did; a serverless deployment keeps it in the database, because the next request
// may reach another instance. The runtime mode (src/runtime/mode.ts) decides, and the other store is
// never built: a server never opens the database for the code, and a serverless instance has no
// code in memory to confuse with the real one.
import { resolveRuntimeMode } from "../runtime/mode.ts";
import type { SetupCodeGuard } from "./code-store.ts";

export function selectSetupCodeGuard({
  env,
  memory,
  database,
}: {
  env: Readonly<Record<string, string | undefined>>;
  memory: () => SetupCodeGuard;
  database: () => SetupCodeGuard;
}): SetupCodeGuard {
  return resolveRuntimeMode(env) === "serverless" ? database() : memory();
}
