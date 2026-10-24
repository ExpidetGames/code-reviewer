// SPDX-License-Identifier: LicenseRef-Proprietary

// The key mode of a workspace for the code that serves a person (ADR 0006, P3, D4; #496): who may read and set it, what is accepted,
// and the audit line of a change. Every member reads it; only an Owner and an Admin set it (`manage_llm_key`, the action of the
// LLM access page where the choice is made: the choice says whose key the reviews use, and the key is what that action manages;
// `manage_billing` has the same minimum role today and a Member has neither). A Member gets `forbidden` and nothing is stored or
// logged for them. A workspace cannot choose its own key while it has none stored, for any provider: the choice would end every
// review `llm_not_configured` (`own_key_missing`); choosing our models needs nothing of the workspace. An error names a code, never
// a value.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { can } from "../workspaces/permissions.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { DEFAULT_LLM_KEY_MODE } from "../workspaces/effective-key-mode.ts";
import { KEY_MODES, type KeyMode } from "../workspaces/entitlements.ts";
import { createLlmKeyModeStore } from "./key-mode-store.ts";
import type { WorkspaceLlmKeyService } from "./workspace-key.ts";

export const KEY_MODE_ERROR_CODES = [
  "forbidden",
  "key_mode_invalid",
  "own_key_missing",
] as const;
export type KeyModeErrorCode = (typeof KEY_MODE_ERROR_CODES)[number];

export type KeyModeActor = {
  workspaceId: string;
  userId: string;
  /** How the app names who saved a setting: the GitHub login, else the address (`actorName`). */
  name: string;
  role: WorkspaceRole;
};

export type KeyModeResult =
  { ok: true; keyMode: KeyMode } | { ok: false; error: KeyModeErrorCode };

/** What the LLM access page shows: the choice that applies, and whether a key of the workspace's own is stored. */
export type KeyChoiceView = { keyMode: KeyMode; hasOwnKey: boolean };

export type LlmKeyModeService = {
  choiceOf(workspaceId: string): Promise<KeyChoiceView>;
  /** What the workspace chose; our models until it did. Every member may ask. */
  get(workspaceId: string): Promise<KeyModeResult>;
  /** The body is what the person sent: `{ keyMode: "managed" | "own" }`. */
  set(actor: KeyModeActor, body: unknown): Promise<KeyModeResult>;
};

export function createLlmKeyModeService({
  db,
  keysOf,
  now,
  log = (line) => console.info(line),
}: {
  db: Kysely<Database>;
  /** The key service of ONE workspace (the assembly's `keyServiceFor`). */
  keysOf: (
    workspaceId: string,
  ) => Pick<WorkspaceLlmKeyService, "statusAll" | "nativeStatuses">;
  now?: () => Date;
  /** Receives the audit line: ids and a stable action only, no name and no address. */
  log?: (line: string) => void;
}): LlmKeyModeService {
  const storeOf = (workspaceId: string) =>
    createLlmKeyModeStore(db, workspaceId, now);

  async function hasOwnKey(workspaceId: string): Promise<boolean> {
    const keys = keysOf(workspaceId);
    const statuses = [
      ...(await keys.statusAll()),
      ...(await keys.nativeStatuses()),
    ];
    return statuses.some(({ status }) => status.state === "configured");
  }

  return {
    async choiceOf(workspaceId) {
      return {
        keyMode: (await storeOf(workspaceId).get()) ?? DEFAULT_LLM_KEY_MODE,
        hasOwnKey: await hasOwnKey(workspaceId),
      };
    },

    async get(workspaceId) {
      return {
        ok: true,
        keyMode: (await storeOf(workspaceId).get()) ?? DEFAULT_LLM_KEY_MODE,
      };
    },

    async set(actor, body) {
      if (!can(actor.role, "manage_llm_key"))
        return { ok: false, error: "forbidden" };
      const requested =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).keyMode
          : undefined;
      const keyMode = KEY_MODES.find((mode) => mode === requested);
      if (keyMode === undefined)
        return { ok: false, error: "key_mode_invalid" };
      if (keyMode === "own" && !(await hasOwnKey(actor.workspaceId)))
        return { ok: false, error: "own_key_missing" };
      await storeOf(actor.workspaceId).set(keyMode, actor.name);
      // The audit line points at who changed what; the setting keeps who and when too.
      log(
        `[llm] KEY_MODE_CHANGED workspace=${actor.workspaceId} user=${actor.userId} key_mode=${keyMode}`,
      );
      return { ok: true, keyMode };
    },
  };
}
