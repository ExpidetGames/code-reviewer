// SPDX-License-Identifier: LicenseRef-Proprietary

// What the App knows of its Dispatchers (#498; the gate of the review of #524): a claim that names `worker_credential` is a
// Dispatcher's, and `vm_lifecycle` next to it says it reports the VMs it creates. The App keeps when it last saw one with and
// one without, at most once an hour each, so billing is not switched on over a Dispatcher that measures no minutes.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  noteDispatcherClaim,
  readStoredDispatcherSightings,
} from "./dispatcher-features.ts";

const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-10-21T08:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("noting the Dispatcher of a claim", () => {
  // #498-B1
  it("records a Dispatcher with `vm_lifecycle` and one without, apart", async () => {
    const { db } = await createTestDatabase();

    await noteDispatcherClaim(db, ["worker_credential", "vm_lifecycle"], T0);
    await noteDispatcherClaim(db, ["worker_credential"], later(5 * HOUR));

    expect(await readStoredDispatcherSightings(db)).toStrictEqual({
      withVmLifecycleAt: T0.toISOString(),
      withoutVmLifecycleAt: later(5 * HOUR).toISOString(),
    });
  });

  // #498-B1
  it("does not record a runner: only a claim that names the per-job credential is a Dispatcher's", async () => {
    const { db } = await createTestDatabase();

    await noteDispatcherClaim(db, [], T0);
    await noteDispatcherClaim(db, ["vm_lifecycle", "supersede"], T0);

    expect(await readStoredDispatcherSightings(db)).toStrictEqual({});
  });

  // #498-B1
  it("writes at most once an hour for the same kind of Dispatcher", async () => {
    const { db } = await createTestDatabase();
    const settings = createInstanceSettingsRepository(db);
    await noteDispatcherClaim(db, ["worker_credential", "vm_lifecycle"], T0);
    const first = await settings.getWithMeta("dispatcher_sightings");

    await noteDispatcherClaim(
      db,
      ["worker_credential", "vm_lifecycle"],
      later(30 * 60 * 1000),
    );
    expect(await settings.getWithMeta("dispatcher_sightings")).toStrictEqual(
      first,
    );

    await noteDispatcherClaim(
      db,
      ["worker_credential", "vm_lifecycle"],
      later(HOUR + 1),
    );
    expect(await readStoredDispatcherSightings(db)).toStrictEqual({
      withVmLifecycleAt: later(HOUR + 1).toISOString(),
    });
  });

  // #498-B1
  it("never throws: a claim does not fail because of a note", async () => {
    const { db } = await createTestDatabase();
    await db.destroy();

    await expect(
      noteDispatcherClaim(db, ["worker_credential"], T0),
    ).resolves.toBeUndefined();
  });
});
