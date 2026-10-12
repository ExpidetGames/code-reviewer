// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server: the LLM access of a workspace on the server's database, with the master key
// and the legacy variables from the process environment as they are right now (read on every call, never
// cached, so a changed value is used by the next claim or page).
import "server-only";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { getDatabase } from "../db/startup.ts";
import { createWorkspaceLlm, type WorkspaceLlmAssembly } from "./assemble.ts";

export function getWorkspaceLlm(): WorkspaceLlmAssembly {
  return createWorkspaceLlm({
    db: getDatabase(),
    appSecret: () => {
      const resolved = resolveAppSecret(process.env);
      // The server does not start without it (src/auth/startup.ts); this is the second line.
      if (!resolved.ok) throw new Error(resolved.problem);
      return resolved.secret;
    },
    env: () => process.env,
  });
}
