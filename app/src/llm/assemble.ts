// SPDX-License-Identifier: Apache-2.0

// The LLM access of a workspace, put together over a database: the key service of the workspace, the operator's
// key, the access a job of the workspace gets (src/llm/resolve.ts: the key mode of its entitlements decides whose
// key it is) and what the pages may show. The same code serves the running server (shared.ts) and the tests,
// which build it over a test database and a chosen environment.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { createSecretStore } from "../secrets/store.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import {
  type LlmAccessResult,
  type LlmAccessSource,
  type LlmNotConfiguredReason,
} from "./access.ts";
import { readLlmDefaults } from "./config.ts";
import {
  createOperatorLlmKeyService,
  type OperatorLlmKeyService,
} from "./operator-key.ts";
import {
  keyModeForJob,
  resolveWorkspaceLlmAccess,
  type ResolveLlmInput,
} from "./resolve.ts";
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
  /**
   * The operator's own key (the instance admin saves it; only the admin portal and this assembly use it). It is
   * the key of a workspace whose key mode is `managed`, and of no other.
   */
  operatorKey(): OperatorLlmKeyService;
  /**
   * The access a job of this workspace gets, or `llm_not_configured`: the key its key mode names, the
   * workspace's own or the operator's, never the other. Nothing of another workspace is read.
   */
  accessFor(workspaceId: string): Promise<LlmAccessResult>;
  summaryFor(workspaceId: string): Promise<WorkspaceLlmSummary>;
  /**
   * The LLM keys that are current for this workspace right now, to mask in the result of one of its jobs: its
   * own key, and the operator's while the workspace is `managed`. Best effort: a key that cannot be read is left
   * out.
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

  const operatorKey = () =>
    createOperatorLlmKeyService({
      store: createSecretStore({
        db,
        appSecret: appSecret(),
        ...(now === undefined ? {} : { now }),
      }),
    });

  // What the key mode of the workspace's entitlements asks for, and only that: a managed job never reads the
  // workspace's key, and any other job never reads the operator's.
  async function resolveInput(workspaceId: string): Promise<ResolveLlmInput> {
    const mode = keyModeForJob(
      await readEffectiveEntitlements(db, workspaceId, now),
    );
    // The model and the context window of the instance; the key is the one the mode names.
    const defaults = readLlmDefaults(env());
    if (mode === "unreadable") return { keyMode: mode, defaults };
    if (mode === "managed")
      return {
        keyMode: mode,
        operatorKey: await operatorKey().forJob(),
        defaults,
      };
    return {
      keyMode: mode,
      key: await keyServiceFor(workspaceId).forJob(),
      defaults,
    };
  }

  async function accessFor(workspaceId: string): Promise<LlmAccessResult> {
    return resolveWorkspaceLlmAccess(await resolveInput(workspaceId));
  }

  return {
    keyServiceFor,
    operatorKey,
    accessFor,
    async summaryFor(workspaceId) {
      return summarizeLlmAccess(await accessFor(workspaceId));
    },
    async currentKeysFor(workspaceId) {
      const keys: string[] = [];
      const own = await keyServiceFor(workspaceId).forJob();
      if (own.state === "key") keys.push(own.apiKey);
      const mode = keyModeForJob(
        await readEffectiveEntitlements(db, workspaceId, now),
      );
      if (mode !== "managed") return keys;
      const operator = await operatorKey().forJob();
      if (operator.state === "key") keys.push(operator.apiKey);
      return keys;
    },
  };
}
