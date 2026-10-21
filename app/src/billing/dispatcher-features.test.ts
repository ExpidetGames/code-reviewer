// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DISPATCHER_STALE_MS,
  canSwitchBillingOnWithDispatcher,
  dispatcherReadiness,
  readDispatcherSightings,
} from "./dispatcher-features.ts";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

describe("whether the Dispatchers measure billable minutes", () => {
  // #498-B1
  it("is ready when no Dispatcher has ever claimed (a self-hosted instance has none)", () => {
    expect(dispatcherReadiness({}, NOW)).toStrictEqual({ ok: true });
  });

  // #498-B1
  it("is ready when every Dispatcher seen reports its VMs", () => {
    expect(
      dispatcherReadiness({ withVmLifecycleAt: ago(HOUR) }, NOW),
    ).toStrictEqual({ ok: true });
  });

  // #498-B1
  it("refuses while a Dispatcher without `vm_lifecycle` has claimed lately, even next to one that has it", () => {
    const refused = {
      ok: false,
      code: "dispatcher_lacks_vm_lifecycle",
    } as const;

    expect(
      dispatcherReadiness({ withoutVmLifecycleAt: ago(HOUR) }, NOW),
    ).toStrictEqual(refused);
    expect(
      dispatcherReadiness(
        { withVmLifecycleAt: ago(HOUR), withoutVmLifecycleAt: ago(2 * HOUR) },
        NOW,
      ),
    ).toStrictEqual(refused);
  });

  // #498-B1
  it("forgets a Dispatcher without it that has not claimed for a day (a rollout that finished)", () => {
    expect(
      dispatcherReadiness(
        {
          withVmLifecycleAt: ago(HOUR),
          withoutVmLifecycleAt: ago(DISPATCHER_STALE_MS + HOUR),
        },
        NOW,
      ),
    ).toStrictEqual({ ok: true });
  });

  // #498-B1
  it("reads a stored value that is not the shape as no sighting", () => {
    for (const stored of [
      undefined,
      null,
      "x",
      [],
      { withVmLifecycleAt: 5, withoutVmLifecycleAt: "not a date" },
    ])
      expect(readDispatcherSightings(stored)).toStrictEqual({});
  });

  // #498-B1
  it("joins the check of the rates with the one of the Dispatchers, the rates first", () => {
    const complete = {
      factorA: 50_000,
      minuteRateMicroUsd: { diff: 1, dynamic: 1 },
      diffAiReserveMicroUsd: 0,
    };

    expect(canSwitchBillingOnWithDispatcher(complete, {}, NOW)).toStrictEqual({
      ok: true,
    });
    expect(
      canSwitchBillingOnWithDispatcher(
        complete,
        { withoutVmLifecycleAt: ago(HOUR) },
        NOW,
      ),
    ).toStrictEqual({ ok: false, code: "dispatcher_lacks_vm_lifecycle" });
    expect(
      canSwitchBillingOnWithDispatcher(
        {},
        { withoutVmLifecycleAt: ago(HOUR) },
        NOW,
      ),
    ).toStrictEqual({ ok: false, code: "billing_rates_incomplete" });
  });
});
