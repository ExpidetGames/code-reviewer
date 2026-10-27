// SPDX-License-Identifier: LicenseRef-Proprietary

// What the App knows of its Dispatchers (ADR 0006, 2.11; #498, the gate of the review of #524). Billable minutes of a hosted job
// come from the VM the Dispatcher reports (`vm_lifecycle`). A Dispatcher of an earlier release reports nothing, and the job
// would then be priced by its claim wall clock instead: right in the end, but a deployment that mixes the two should be fixed
// before money moves. A claim that names `worker_credential` is a Dispatcher's; `vm_lifecycle` next to it says it reports
// its VMs. The App keeps when it last saw one of each kind (an instance setting, written at most once an hour per kind), and
// billing is not switched on while a Dispatcher without it has claimed within a day. An instance with no Dispatcher (a
// self-hosted runner) has never been seen, and is ready.
//
// The check joins the one of the rates (`canSwitchBillingOn`, rates.ts). It is asked where the switch is written (#504),
// inside the same transaction that writes `enabled`.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsStore } from "../db/repositories/instance-settings-store.ts";
import type { Database } from "../db/schema.ts";
import {
  BILLING_RATES_INCOMPLETE,
  canSwitchBillingOn,
  isRecord,
  type StoredBillingRates,
} from "./rates.ts";

/** When the App last saw a Dispatcher of each kind, ISO 8601 text in UTC; a kind never seen has no field. */
export type DispatcherSightings = {
  withVmLifecycleAt?: string;
  withoutVmLifecycleAt?: string;
};

/** The instance setting that holds them (`instance_settings`, key `dispatcher_sightings`). */
type SightingValues = { dispatcher_sightings: DispatcherSightings };

/** A Dispatcher without `vm_lifecycle` that has not claimed for this long is a rollout that finished. */
export const DISPATCHER_STALE_MS = 24 * 60 * 60 * 1000;
/** A sighting is written again only when the stored one is this old. */
export const DISPATCHER_NOTE_INTERVAL_MS = 60 * 60 * 1000;

export const DISPATCHER_LACKS_VM_LIFECYCLE = "dispatcher_lacks_vm_lifecycle";

export type DispatcherReadiness =
  { ok: true } | { ok: false; code: typeof DISPATCHER_LACKS_VM_LIFECYCLE };

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** The stored value as sightings; anything that is not the shape reads as no sighting. */
export function readDispatcherSightings(stored: unknown): DispatcherSightings {
  if (!isRecord(stored)) return {};
  const sightings: DispatcherSightings = {};
  if (validTime(stored.withVmLifecycleAt))
    sightings.withVmLifecycleAt = stored.withVmLifecycleAt;
  if (validTime(stored.withoutVmLifecycleAt))
    sightings.withoutVmLifecycleAt = stored.withoutVmLifecycleAt;
  return sightings;
}

export async function readStoredDispatcherSightings(
  db: Kysely<Database>,
): Promise<DispatcherSightings> {
  return readDispatcherSightings(
    await createInstanceSettingsStore<SightingValues>(db).get(
      "dispatcher_sightings",
    ),
  );
}

/**
 * Notes the Dispatcher of a claim, if it is one. Never throws and never delays a claim by more than the one read: a note
 * is a convenience of the admin who switches billing on, not a part of the claim.
 */
export async function noteDispatcherClaim(
  db: Kysely<Database>,
  features: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  try {
    if (!features.includes("worker_credential")) return;
    const field: keyof DispatcherSightings = features.includes("vm_lifecycle")
      ? "withVmLifecycleAt"
      : "withoutVmLifecycleAt";
    const sightings = await readStoredDispatcherSightings(db);
    const last = sightings[field];
    if (
      last !== undefined &&
      now.getTime() - Date.parse(last) < DISPATCHER_NOTE_INTERVAL_MS
    )
      return;
    await createInstanceSettingsStore<SightingValues>(db).set(
      "dispatcher_sightings",
      { ...sightings, [field]: now.toISOString() },
      null,
    );
  } catch {
    console.error("[billing] DISPATCHER_NOT_NOTED");
  }
}

export function dispatcherReadiness(
  sightings: DispatcherSightings,
  now: Date,
): DispatcherReadiness {
  const { withoutVmLifecycleAt } = sightings;
  if (
    withoutVmLifecycleAt !== undefined &&
    now.getTime() - Date.parse(withoutVmLifecycleAt) <= DISPATCHER_STALE_MS
  )
    return { ok: false, code: DISPATCHER_LACKS_VM_LIFECYCLE };
  return { ok: true };
}

export type SwitchOnWithDispatcherCheck =
  | { ok: true }
  | {
      ok: false;
      code:
        typeof BILLING_RATES_INCOMPLETE | typeof DISPATCHER_LACKS_VM_LIFECYCLE;
    };

/** `canSwitchBillingOn` and the Dispatchers: the rates first (an operator sets those), then the deployment. */
export function canSwitchBillingOnWithDispatcher(
  stored: StoredBillingRates,
  sightings: DispatcherSightings,
  now: Date,
): SwitchOnWithDispatcherCheck {
  const rates = canSwitchBillingOn(stored);
  if (!rates.ok) return rates;
  return dispatcherReadiness(sightings, now);
}
