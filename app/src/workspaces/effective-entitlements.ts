// SPDX-License-Identifier: Apache-2.0

// The entitlements that apply to ONE workspace right now: its own row, else the instance default, else none
// (`resolveEntitlements`, src/workspaces/entitlements.ts), with the key mode that applies (`applyWorkspaceKeyMode`, #496): the
// entitlement's while billing is off, the workspace's own choice while it is on. The one place that reads the stores for that
// answer, so the claim's admission (claim-admission.ts), the choice of the LLM key (src/llm/assemble.ts) and the selection of the
// model can never read them differently. The default is only read when the workspace has no row of its own; the choice of the
// workspace is only read while billing is on, so a self-hoster who never switches billing on reads nothing new.
import "server-only";
import type { Kysely } from "kysely";
import { isBillingOn } from "../billing/enabled.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { Database } from "../db/schema.ts";
import { createLlmKeyModeStore } from "../llm/key-mode-store.ts";
import { applyWorkspaceKeyMode } from "./effective-key-mode.ts";
import {
  resolveEntitlements,
  type ResolvedEntitlements,
} from "./entitlements.ts";

export async function readEffectiveEntitlements(
  db: Kysely<Database>,
  workspaceId: string,
  now: () => Date = () => new Date(),
  /**
   * Whether billing is on, for a caller that has read the switch already (the claim reads it once for the whole claim); left out,
   * it is read here.
   */
  billing: { on: boolean } | undefined = undefined,
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
  const entitlements = resolveEntitlements(row, defaults);
  const billingOn = billing?.on ?? (await isBillingOn(db));
  if (!billingOn) return entitlements;
  return applyWorkspaceKeyMode(entitlements, {
    billingOn,
    workspaceChoice: await createLlmKeyModeStore(db, workspaceId, now).get(),
  });
}
