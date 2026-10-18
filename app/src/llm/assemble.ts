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
  DEFAULT_LLM_PROVIDER,
  llmProviderDescriptors,
} from "./providers/index.ts";
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
  type ProviderLookup,
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
   * The operator's own keys, one for each provider (the instance admin saves them; only the admin portal and this
   * assembly use them). They are the keys of a workspace whose key mode is `managed`, and of no other.
   */
  operatorKey(): OperatorLlmKeyService;
  /**
   * The access a job of this workspace gets, or `llm_not_configured`: the key its key mode names, the
   * workspace's own or the operator's, never the other. The own key is the one of `provider` (the default provider
   * until a project can choose); a key of another provider is never used. Nothing of another workspace is read.
   */
  accessFor(workspaceId: string, provider?: string): Promise<LlmAccessResult>;
  summaryFor(
    workspaceId: string,
    provider?: string,
  ): Promise<WorkspaceLlmSummary>;
  /**
   * The LLM keys that are current for this workspace right now, to mask in the result of one of its jobs: its
   * own key of every provider, and the operator's key of every provider while the workspace is `managed`. Best effort: a key that cannot
   * be read is left out.
   */
  currentKeysFor(workspaceId: string): Promise<string[]>;
};

export function createWorkspaceLlm({
  db,
  appSecret,
  env,
  now,
  providers = llmProviderDescriptors,
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
  /** The providers the app supports; a test passes its own. */
  providers?: ProviderLookup;
}): WorkspaceLlmAssembly {
  const keyServiceFor = (workspaceId: string) =>
    createWorkspaceLlmKeyService({
      store: createWorkspaceSecretStore({
        db,
        workspaceId,
        appSecret: appSecret(),
        ...(now === undefined ? {} : { now }),
      }),
      providers,
    });

  const operatorKey = () =>
    createOperatorLlmKeyService({
      store: createSecretStore({
        db,
        appSecret: appSecret(),
        ...(now === undefined ? {} : { now }),
      }),
      providers,
    });

  // What the key mode of the workspace's entitlements asks for, and only that: a managed job never reads the
  // workspace's key, and any other job never reads the operator's.
  async function resolveInput(
    workspaceId: string,
    provider: string,
  ): Promise<ResolveLlmInput> {
    const mode = keyModeForJob(
      await readEffectiveEntitlements(db, workspaceId, now),
    );
    // The model and the context window of the instance; the key is the one the mode names.
    const defaults = readLlmDefaults(env());
    if (mode === "unreadable") return { keyMode: mode, defaults };
    if (mode === "managed")
      return {
        keyMode: mode,
        provider,
        operatorKey: await operatorKey().forJob(provider),
        defaults,
      };
    return {
      keyMode: mode,
      provider,
      key: await keyServiceFor(workspaceId).keyFor(provider),
      defaults,
    };
  }

  async function accessFor(
    workspaceId: string,
    provider: string = DEFAULT_LLM_PROVIDER,
  ): Promise<LlmAccessResult> {
    return resolveWorkspaceLlmAccess(
      await resolveInput(workspaceId, provider),
      providers,
    );
  }

  return {
    keyServiceFor,
    operatorKey,
    accessFor,
    async summaryFor(workspaceId, provider) {
      return summarizeLlmAccess(await accessFor(workspaceId, provider));
    },
    async currentKeysFor(workspaceId) {
      const keys: string[] = [];
      const service = keyServiceFor(workspaceId);
      for (const id of providers.ids) {
        const own = await service.keyFor(id);
        if (own.state === "key") keys.push(own.apiKey);
      }
      const mode = keyModeForJob(
        await readEffectiveEntitlements(db, workspaceId, now),
      );
      if (mode !== "managed") return keys;
      const operators = operatorKey();
      for (const id of providers.ids) {
        const operator = await operators.forJob(id);
        if (operator.state === "key") keys.push(operator.apiKey);
      }
      return keys;
    },
  };
}
