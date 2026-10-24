// SPDX-License-Identifier: LicenseRef-Proprietary

// The data of the balance banner (ADR 0006, D9; #506): for an Owner and an Admin (`manage_billing`), while billing is on and the
// balance of THEIR workspace is low, zero or below zero. A Member gets null before anything is read; billing off gets null after
// the one read of the instance switch (not a billing table). The banner carries the balance and the way to the billing page.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import type { Database } from "../db/schema.ts";
import type { BalanceBannerView } from "../workspace-billing/banner.ts";
import { workspacePath } from "../workspaces/paths.ts";
import { can } from "../workspaces/permissions.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { balanceLevelOf } from "./balance-state.ts";
import { readBillingSwitch } from "./enabled.ts";

export async function loadBalanceBanner({
  db,
  workspace,
  role,
  now,
}: {
  db: Kysely<Database>;
  workspace: { id: string; slug: string };
  role: WorkspaceRole;
  now?: () => Date;
}): Promise<BalanceBannerView | null> {
  if (!can(role, "manage_billing")) return null;
  const billing = await readBillingSwitch(db);
  if (!billing.enabled || billing.missing.length > 0) return null;
  const { balanceMicroUsd } = await createBillingJournalRepository(
    db,
    workspace.id,
    now,
  ).balance();
  const level = balanceLevelOf(balanceMicroUsd, billing.lowBalanceMicroUsd);
  if (level === "ok") return null;
  return {
    level,
    balanceMicroUsd,
    billingHref: workspacePath(workspace.slug, "/settings/billing"),
  };
}
