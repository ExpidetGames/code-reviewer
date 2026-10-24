// SPDX-License-Identifier: LicenseRef-Proprietary

// What the server does about the setup when it starts (called from src/instrumentation.ts, after the
// migrations): while the instance is not set up, every start of a process prints a fresh setup code
// with one clear line and keeps its hash in the memory of this process. This is the only place that
// ever shows the code, and only in the server's own log: it is never sent over HTTP. A set up
// instance prints nothing.
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { SETUP_CODE_TTL_MS, type SetupCodeStore } from "./code-store.ts";
import { readSetupState, type SetupState } from "./state.ts";

export type SetupStart =
  | { setUp: true }
  | { setUp: false; state: Exclude<SetupState, { kind: "completed" }> };

export async function startSetupOnStart({
  db,
  store,
  log = (line) => console.info(line),
}: {
  db: Kysely<Database>;
  store: SetupCodeStore;
  log?: (line: string) => void;
}): Promise<SetupStart> {
  const state = await readSetupState(db);
  if (state.kind === "completed") return { setUp: true };
  const code = store.issue();
  log(
    `[setup] Setup code: ${code}  This instance is not set up yet. Open it in a browser and enter the code (valid for ${String(SETUP_CODE_TTL_MS / 60_000)} minutes; restart the app for a new one).`,
  );
  return { setUp: false, state };
}
