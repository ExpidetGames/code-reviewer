// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the LLM access of a workspace on the server's database, with the master key
// and the legacy variables from the process environment as they are right now (read on every call, never
// cached, so a changed value is used by the next claim or page).
import "server-only";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { getDatabase } from "../db/startup.ts";
import { createWorkspaceLlm, type WorkspaceLlmAssembly } from "./assemble.ts";
import { llmApiBaseUrl } from "./endpoint.ts";
import { createWiredLlmKeyTester } from "./key-tester.ts";
import type { LlmKeyTestService } from "./key-test.ts";
import { createModelCapabilityChecker } from "./model-capabilities.ts";

// One checker for the process, so a supported answer is remembered across requests and workspaces: the
// metadata is public and the same for everybody. The settings save (#269) and the claim of a Dynamic job
// (#279) both read through it. The address is read on every ask (the test stack's switch).
export const modelCapabilities = createModelCapabilityChecker({
  baseUrl: (provider) => llmApiBaseUrl(process.env, provider).url,
});

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

/**
 * The "test key" service of the running server: counted in the shared `rate_limits` table, and connecting to
 * the provider's own address only (src/llm/endpoint.ts: the test stack may point it at the fake LLM).
 */
export function getLlmKeyTester(): LlmKeyTestService {
  return createWiredLlmKeyTester({
    db: getDatabase(),
    env: () => process.env,
  });
}
