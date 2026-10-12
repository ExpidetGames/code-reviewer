// SPDX-License-Identifier: Apache-2.0

// The LLM access of a workspace, put together over a database: the key service of the workspace, the access a
// job of the workspace gets (src/llm/resolve.ts) and what the pages may show. The same code serves the running
// server (shared.ts) and the tests, which build it over a test database and a chosen environment.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import {
  type LlmAccessResult,
  type LlmAccessSource,
  type LlmNotConfiguredReason,
} from "./access.ts";
import { readLlmDefaults } from "./config.ts";
import { resolveWorkspaceLlmAccess } from "./resolve.ts";
import {
  createWorkspaceLlmKeyService,
  type WorkspaceLlmKeyService,
} from "./workspace-key.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** What the pages may know about the access of a workspace. Never a key, never a variable's value. */
export type WorkspaceLlmSummary =
  | { configured: true; source: LlmAccessSource }
  | { configured: false; reason: LlmNotConfiguredReason };

export function summarizeLlmAccess(
  result: LlmAccessResult,
): WorkspaceLlmSummary {
  return result.ok
    ? { configured: true, source: result.source }
    : { configured: false, reason: result.reason };
}

export type WorkspaceLlmAssembly = {
  keyServiceFor(workspaceId: string): WorkspaceLlmKeyService;
  /** The access a job of this workspace gets, or `llm_not_configured`. Nothing of another workspace is read. */
  accessFor(workspaceId: string): Promise<LlmAccessResult>;
  summaryFor(workspaceId: string): Promise<WorkspaceLlmSummary>;
  /**
   * The LLM keys that are current for this workspace right now, to mask in the result of one of its jobs: its
   * own key. Best effort: a key that cannot be read is left out.
   */
  currentKeysFor(workspaceId: string): Promise<string[]>;
};

export function createWorkspaceLlm({
  db,
  appSecret,
  env,
  now,
}: {
  db: Kysely<Database>;
  /**
   * The master key (`APP_SECRET`), asked for when it is needed: building the assembly never fails for want of
   * it (the runner API checks its token before anything else is touched).
   */
  appSecret: () => string;
  /** The environment as it is NOW; read on every call, never cached. */
  env: () => Env;
  now?: () => Date;
}): WorkspaceLlmAssembly {
  const keyServiceFor = (workspaceId: string) =>
    createWorkspaceLlmKeyService({
      store: createWorkspaceSecretStore({
        db,
        workspaceId,
        appSecret: appSecret(),
        ...(now === undefined ? {} : { now }),
      }),
    });

  async function accessFor(workspaceId: string): Promise<LlmAccessResult> {
    return resolveWorkspaceLlmAccess({
      key: await keyServiceFor(workspaceId).forJob(),
      // The operator's "included" usage is a stub that is off until the pricing phase (section 2.8).
      operator: null,
      // The model and the context window of the instance; the key is only ever the workspace's own.
      defaults: readLlmDefaults(env()),
    });
  }

  return {
    keyServiceFor,
    accessFor,
    async summaryFor(workspaceId) {
      return summarizeLlmAccess(await accessFor(workspaceId));
    },
    async currentKeysFor(workspaceId) {
      const keys: string[] = [];
      const own = await keyServiceFor(workspaceId).forJob();
      if (own.state === "key") keys.push(own.apiKey);
      return keys;
    },
  };
}
