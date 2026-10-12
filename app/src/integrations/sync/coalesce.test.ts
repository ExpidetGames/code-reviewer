// SPDX-License-Identifier: Apache-2.0

// Pins down that overlapping full syncs share one run: the second caller gets the running one, a call
// after it finished starts a new one, and a failed run does not stay in the way.
import { describe, expect, it } from "vitest";
import { coalesceSyncAll } from "./coalesce.ts";
import type { IntegrationSyncService, SyncSummary } from "./service.ts";

const SUMMARY = (added: number): SyncSummary => ({
  integrations: { created: 0, updated: 0, enabled: 0, disabled: 0 },
  repositories: {
    added,
    reactivated: 0,
    updated: 0,
    deactivated: 0,
    unchanged: 0,
  },
  errors: [],
});

function fakeService() {
  const pending: Array<{
    resolve: (summary: SyncSummary) => void;
    reject: (error: Error) => void;
  }> = [];
  let calls = 0;
  const service = {
    syncAll() {
      calls += 1;
      return new Promise<SyncSummary>((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
    syncIntegration: async () => SUMMARY(0),
  } as unknown as IntegrationSyncService;
  return { service, pending, calls: () => calls };
}

describe("coalescing full syncs", () => {
  // CR-21-T07 (the button part: several requests, one read of GitHub)
  it("gives a second caller the run that is already going", async () => {
    const { service, pending, calls } = fakeService();
    const sync = coalesceSyncAll(service);

    const first = sync.syncAll();
    const second = sync.syncAll();
    pending[0]?.resolve(SUMMARY(2));

    expect(calls()).toBe(1);
    expect(await first).toBe(await second);
    expect((await first).repositories.added).toBe(2);
  });

  it("starts a new run for a call after the first one finished", async () => {
    const { service, pending, calls } = fakeService();
    const sync = coalesceSyncAll(service);
    const first = sync.syncAll();
    pending[0]?.resolve(SUMMARY(1));
    await first;

    const second = sync.syncAll();
    pending[1]?.resolve(SUMMARY(0));

    expect(calls()).toBe(2);
    expect((await second).repositories.added).toBe(0);
  });

  it("does not let a failed run block the next call", async () => {
    const { service, pending, calls } = fakeService();
    const sync = coalesceSyncAll(service);
    const first = sync.syncAll();
    pending[0]?.reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");

    const second = sync.syncAll();
    pending[1]?.resolve(SUMMARY(0));

    expect(calls()).toBe(2);
    await expect(second).resolves.toBeDefined();
  });

  it("leaves the other operations of the service as they are", async () => {
    const { service } = fakeService();

    const summary = await coalesceSyncAll(service).syncIntegration("i1");

    expect(summary.repositories.added).toBe(0);
  });
});
