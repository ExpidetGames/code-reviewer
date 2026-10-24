// SPDX-License-Identifier: LicenseRef-Proprietary

// The key mode a workspace chose for its reviews (#496): `managed` (our models) or `own` (its own provider key). One setting of the
// workspace (`llm_key_mode` in `app_settings`, next to its review defaults), written by an Owner or an Admin through
// `key-mode-service.ts`. It only has a meaning while billing is on (`effectiveKeyMode`, src/workspaces/effective-key-mode.ts); a
// workspace that has not chosen is `managed` then. A stored value that is none of the two reads as not chosen.
import "server-only";
import type { Kysely } from "kysely";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import { KEY_MODES, type KeyMode } from "../workspaces/entitlements.ts";

export const LLM_KEY_MODE_SETTING = "llm_key_mode";

export type LlmKeyModeStore = {
  /** What the workspace chose, or `undefined` when it has not (or the stored value is not a key mode). */
  get(): Promise<KeyMode | undefined>;
  /** `updatedBy` is the name the app keeps for who saved a setting (the GitHub login, else the address). */
  set(mode: KeyMode, updatedBy: string | null): Promise<void>;
};

export function createLlmKeyModeStore(
  db: Kysely<Database>,
  workspaceId: string,
  now?: () => Date,
): LlmKeyModeStore {
  const settings = createAppSettingsRepository(db, workspaceId, now);
  return {
    async get() {
      const stored = (await settings.get(LLM_KEY_MODE_SETTING))?.value;
      return KEY_MODES.find((mode) => mode === stored);
    },
    async set(mode, updatedBy) {
      await settings.set(LLM_KEY_MODE_SETTING, mode, updatedBy);
    },
  };
}
