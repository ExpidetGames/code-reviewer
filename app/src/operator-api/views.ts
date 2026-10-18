// SPDX-License-Identifier: Apache-2.0

// What the operator API says about entitlements: named fields only. A stored row also carries who saved it, which
// never leaves the app (a user id is personal data); the time of the last write does. The shapes are the
// definitions `StoredEntitlements`, `EffectiveEntitlements` and `EntitlementsFields` of the contract.
import type { StoredEntitlements } from "../db/repositories/workspace-entitlements-repository.ts";
import type {
  EntitlementsData,
  EntitlementsEntry,
  ResolvedEntitlements,
} from "../workspaces/entitlements.ts";

export function fieldsOf(
  data: Omit<EntitlementsData, "source">,
): Required<Omit<EntitlementsData, "source">> {
  return {
    planLabel: data.planLabel,
    keyMode: data.keyMode,
    limits: {
      diffRunsPerPeriod: data.limits.diffRunsPerPeriod,
      dynamicRunsPerPeriod: data.limits.dynamicRunsPerPeriod,
      managedCostLimitMicroUsd: data.limits.managedCostLimitMicroUsd,
      ownKeyCostLimitMicroUsd: data.limits.ownKeyCostLimitMicroUsd,
    },
    periodStart: data.periodStart,
    suspended: data.suspended,
    suspensionCode: data.suspensionCode,
    // #428: always stated, every released entry (null) when the entry says nothing.
    modelAccess: {
      catalogEntries: data.modelAccess?.catalogEntries ?? null,
    },
  };
}

/** The row of a workspace as the API shows it, or null when there is none. */
export function storedView(stored: StoredEntitlements | undefined) {
  if (stored === undefined) return null;
  if ("invalid" in stored)
    return { invalid: true, updatedAt: stored.updatedAt };
  return { ...fieldsOf(stored), updatedAt: stored.updatedAt };
}

/** The default as the API shows it: the fields, `{ invalid: true }` for damaged data, or null when none was set. */
export function defaultView(entry: EntitlementsEntry | undefined) {
  if (entry === undefined) return null;
  return "invalid" in entry ? { invalid: true } : fieldsOf(entry);
}

export function effectiveView(resolved: ResolvedEntitlements) {
  if (resolved.kind === "unlimited") return { kind: "unlimited" };
  if (resolved.kind === "invalid")
    return { kind: "invalid", code: resolved.code, source: resolved.source };
  return { kind: "limited", source: resolved.source, ...fieldsOf(resolved) };
}

const FIELD_NAMES = [
  "planLabel",
  "keyMode",
  "periodStart",
  "suspended",
  "suspensionCode",
] as const;

/**
 * The names of the fields whose value differs between what was stored and what is stored now (for the log: names
 * only, never values). Without a readable earlier state every field is new.
 */
export function changedFieldNames(
  before: EntitlementsEntry | undefined,
  after: EntitlementsData,
): string[] {
  const names: string[] = [];
  const readable = before !== undefined && !("invalid" in before);
  for (const name of FIELD_NAMES)
    if (!readable || before[name] !== after[name]) names.push(name);
  for (const name of Object.keys(after.limits) as Array<
    keyof EntitlementsData["limits"]
  >)
    if (!readable || before.limits[name] !== after.limits[name])
      names.push(`limits.${name}`);
  // #428: a first write that states nothing about it is not a change of it (the log stays as it was).
  const was = readable ? (before.modelAccess?.catalogEntries ?? null) : null;
  const now = after.modelAccess?.catalogEntries ?? null;
  if (JSON.stringify(was) !== JSON.stringify(now)) names.push("modelAccess");
  return names;
}
