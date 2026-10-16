// SPDX-License-Identifier: Apache-2.0

// The entitlements that apply to ONE workspace right now: its own row, else the instance default, else none
// (`resolveEntitlements`, src/workspaces/entitlements.ts). The one place that reads the two stores for that
// answer, so the claim's admission (claim-admission.ts) and the choice of the LLM key (src/llm/assemble.ts) can
// never read them differently. The default is only read when the workspace has no row of its own.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  resolveEntitlements,
  type ResolvedEntitlements,
} from "./entitlements.ts";

export async function readEffectiveEntitlements(
  db: Kysely<Database>,
  workspaceId: string,
  now: () => Date = () => new Date(),
): Promise<ResolvedEntitlements> {
  const row = await createWorkspaceEntitlementsRepository(
    db,
    workspaceId,
    now,
  ).get();
  const defaults =
    row === undefined
      ? await createInstanceSettingsRepository(db, now).getDefaultEntitlements()
      : undefined;
  return resolveEntitlements(row, defaults);
}
