// SPDX-License-Identifier: Apache-2.0

// What a malformed CRON_SECRET does (#364): it refuses the start where the reaper's route is mounted, so a snapshot is
// configured, and is ignored with a warning where there is no route, so a Dispatcher that never reaps is not taken
// down by a variable it does not use.
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { composeDispatcher } from "../compose.ts";
import { ConfigError } from "../config.ts";
import { noLauncher } from "../launchers/none.ts";
import { recordingLogger } from "../test-support/harness.ts";

const BASE = {
  RUNNER_API_URL: "http://127.0.0.1:9",
  RUNNER_TOKEN: "dummy-dispatcher-token-for-tests",
  DISPATCHER_MAX_RUNNING: "2",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET: "dummy-signing-secret-current-0000000000",
};
const BAD = "tiny-cron-secret";

function compose(withReaper: boolean, env: Record<string, string>) {
  const logger = recordingLogger();
  const build = () =>
    composeDispatcher({
      env: { ...BASE, ...env },
      launcher: noLauncher,
      background: () => undefined,
      ...(withReaper
        ? {
            reaper: () => ({
              fleet: new FakeSandboxService(),
              jobLifetimeSeconds: 1500,
              canaryLifetimeSeconds: 450,
            }),
          }
        : {}),
      logger,
    });
  return { build, logger };
}

describe("a malformed CRON_SECRET", () => {
  // #364-T17
  it.each<[string, Record<string, string>, string]>([
    ["is too short", { CRON_SECRET: BAD }, "too_short"],
    [
      "equals the dispatcher credential",
      {
        CRON_SECRET: BASE.RUNNER_TOKEN,
      },
      "not_distinct",
    ],
  ])(
    "refuses the start when the reaper's route is mounted: it %s",
    (_name, env, reason) => {
      const { build } = compose(true, env);

      let error: unknown;
      try {
        build();
      } catch (thrown) {
        error = thrown;
      }

      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variable).toBe("CRON_SECRET");
      expect((error as ConfigError).reason).toBe(reason);
      expect((error as ConfigError).message).not.toContain(BAD);
    },
  );

  // #364-T17
  it("is ignored with a warning, without its value, where no route is mounted", () => {
    const { build, logger } = compose(false, { CRON_SECRET: BAD });

    const dispatcher = build();

    expect(dispatcher.settings.cronSecret).toBeUndefined();
    expect(logger.text()).toContain("cron_secret_ignored");
    expect(logger.text()).toContain("too_short");
    expect(logger.text()).not.toContain(BAD);
  });

  // #364-T17
  it("says nothing where no route is mounted and the secret is good or absent", () => {
    const good = compose(false, {
      CRON_SECRET: "a-cron-secret-of-at-least-32-characters",
    });
    const absent = compose(false, {});

    good.build();
    absent.build();

    expect(good.logger.text()).not.toContain("cron_secret_ignored");
    expect(absent.logger.text()).not.toContain("cron_secret_ignored");
  });
});
