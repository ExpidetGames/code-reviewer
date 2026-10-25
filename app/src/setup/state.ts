// SPDX-License-Identifier: LicenseRef-Proprietary

// What the instance knows about its own setup, read from the explicit marker in `instance_settings`
// and from whether users exist (docs/decisions/0001-editions-setup-and-accounts.md, section 2.2).
// Never inferred from whether a row exists: a database from before the marker reads as
// `setup_completed_at` null.
//
// - completed: `setup_completed_at` is set. The wizard is gone for good.
// - fresh: not completed and no users. Nothing has ever run here: everything but the health check and
//   the static files waits for the setup.
// - existing: not completed, and users exist. Reviews must not stop meanwhile, so
//   the webhooks and the runner API keep working with the settings the instance already has; only
//   the web UI waits for the setup.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";

export type SetupState =
  { kind: "completed" } | { kind: "fresh" } | { kind: "existing" };

export async function readSetupState(
  db: Kysely<Database>,
): Promise<SetupState> {
  const settings = createInstanceSettingsRepository(db);
  if ((await settings.get("setup_completed_at")) != null)
    return { kind: "completed" };
  const user = await db
    .selectFrom("users")
    .select("id")
    .limit(1)
    .executeTakeFirst();
  return user === undefined ? { kind: "fresh" } : { kind: "existing" };
}

export type SetupStateReader = () => Promise<SetupState>;

/**
 * Reads the state on every call until the setup is completed, then never again: "completed" cannot
 * go back, so it is remembered for the life of the process and a set-up instance pays nothing per
 * request.
 */
export function createSetupStateReader(
  read: () => Promise<SetupState>,
): SetupStateReader {
  let completed = false;
  return async () => {
    if (completed) return { kind: "completed" };
    const state = await read();
    if (state.kind === "completed") completed = true;
    return state;
  };
}
