// SPDX-License-Identifier: LicenseRef-Proprietary

// What the instance knows about its own setup, read from the two explicit markers in
// `instance_settings` and from whether users exist (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.2). Never inferred from whether a row exists: a database from before the markers has
// neither, which reads as `setup_completed_at` null and `import_state` `none`.
//
// - completed: `setup_completed_at` is set. The wizard is gone for good.
// - fresh: not completed, no users and `import_state` `none`. Nothing has ever run here: everything
//   but the health check and the static files waits for the setup.
// - existing: not completed, and users exist or the import ran. Reviews must not stop meanwhile, so
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
  const importState = (await settings.get("import_state")) ?? "none";
  const user = await db
    .selectFrom("users")
    .select("id")
    .limit(1)
    .executeTakeFirst();
  return user === undefined && importState === "none"
    ? { kind: "fresh" }
    : { kind: "existing" };
}

export type SetupStateReader = () => Promise<SetupState>;

/**
 * Reads the state on every call until the setup is completed, then never again: "completed" cannot
 * go back, so it is remembered for the life of the process and a set-up instance pays nothing per
 * request. (A database restored from an older backup needs a restart anyway.)
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
