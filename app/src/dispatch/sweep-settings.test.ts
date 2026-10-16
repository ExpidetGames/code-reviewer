// SPDX-License-Identifier: Apache-2.0

// The settings of the cron sweep (#328): the give-up is on by default only where the app wakes a Dispatcher, a
// value that cannot be used keeps the default instead of disabling a bound, and the cap is optional.
import { describe, expect, it } from "vitest";
import { loadSweepSettings } from "./sweep-settings.ts";

describe("the sweep settings", () => {
  // #328-T09
  it("leave the give-up off and the cap unset in poll mode", () => {
    expect(loadSweepSettings({})).toEqual({ giveUpMs: null, maxRunning: null });
    expect(loadSweepSettings({ RUNNER_DISPATCH: "poll" })).toEqual({
      giveUpMs: null,
      maxRunning: null,
    });
  });

  // #328-T04
  it("give up after 60 minutes in webhook mode unless told otherwise", () => {
    expect(loadSweepSettings({ RUNNER_DISPATCH: "webhook" })).toEqual({
      giveUpMs: 3_600_000,
      maxRunning: null,
    });
    expect(loadSweepSettings({ RUNNER_DISPATCH: " Webhook " }).giveUpMs).toBe(
      3_600_000,
    );
  });

  // #328-T09
  it("let the operator turn the give-up on in poll mode, change it in webhook mode, and turn it off with 0", () => {
    expect(
      loadSweepSettings({ RUNNER_DISPATCH_GIVE_UP_SECONDS: "1800" }).giveUpMs,
    ).toBe(1_800_000);
    expect(
      loadSweepSettings({
        RUNNER_DISPATCH: "webhook",
        RUNNER_DISPATCH_GIVE_UP_SECONDS: "7200",
      }).giveUpMs,
    ).toBe(7_200_000);
    expect(
      loadSweepSettings({
        RUNNER_DISPATCH: "webhook",
        RUNNER_DISPATCH_GIVE_UP_SECONDS: "0",
      }).giveUpMs,
    ).toBeNull();
  });

  // #328-T04
  it.each(["abc", "-5", "1.5", "59", "604801", "", "  "])(
    "keep the default for the unusable give-up %j",
    (value) => {
      expect(
        loadSweepSettings({
          RUNNER_DISPATCH: "webhook",
          RUNNER_DISPATCH_GIVE_UP_SECONDS: value,
        }).giveUpMs,
      ).toBe(3_600_000);
      expect(
        loadSweepSettings({ RUNNER_DISPATCH_GIVE_UP_SECONDS: value }).giveUpMs,
      ).toBeNull();
    },
  );

  // #328-T08
  it("read the pool cap from 1 to 1000 and ignore anything else", () => {
    expect(
      loadSweepSettings({ RUNNER_DISPATCH_MAX_RUNNING: "8" }).maxRunning,
    ).toBe(8);
    for (const value of ["0", "1001", "-1", "2.5", "many", ""])
      expect(
        loadSweepSettings({ RUNNER_DISPATCH_MAX_RUNNING: value }).maxRunning,
      ).toBeNull();
  });
});
