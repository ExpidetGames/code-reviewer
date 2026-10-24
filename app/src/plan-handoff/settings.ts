// SPDX-License-Identifier: LicenseRef-Proprietary

// Reading and saving the instance setting `plan_management_url` (README.md). The one place both writers use (the
// admin portal and the operator API), so what is stored is always what `checkPlanManagementUrl` accepts; the reader
// checks again, so a value that was damaged in the database (or saved by hand) is no plan page: the setting reads as
// unset and nothing is handed over.
import type { InstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import {
  checkPlanManagementUrl,
  type PlanManagementUrlErrorCode,
} from "./url.ts";

export type PlanManagementSettings = Pick<
  InstanceSettingsRepository,
  "get" | "set" | "remove"
>;

/** The configured page in its stored form, or null when there is none (or what is stored is not a valid page). */
export async function readPlanManagementUrl(
  settings: Pick<InstanceSettingsRepository, "get">,
): Promise<string | null> {
  const stored = await settings.get("plan_management_url");
  if (stored === undefined) return null;
  const checked = checkPlanManagementUrl(stored);
  return checked.ok ? checked.url : null;
}

export type SavePlanManagementUrlResult =
  { ok: true } | { ok: false; code: PlanManagementUrlErrorCode };

/**
 * Saves the page, or removes it for `null`. `input` is the value as received. `updatedBy` is the instance admin, or
 * null for the operator API.
 */
export async function savePlanManagementUrl(
  settings: PlanManagementSettings,
  input: unknown,
  updatedBy: string | null,
): Promise<SavePlanManagementUrlResult> {
  if (input === null) {
    await settings.remove("plan_management_url");
    return { ok: true };
  }
  const checked = checkPlanManagementUrl(input);
  if (!checked.ok) return checked;
  await settings.set("plan_management_url", checked.url, updatedBy);
  return { ok: true };
}
