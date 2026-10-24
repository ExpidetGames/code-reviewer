// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings of the cron sweep (#328), read from the environment on every run: the one place that knows the
// variable names. Never fails: a value that cannot be used keeps the default, so a typo cannot disable the
// bound it was meant to set (the same rule as `RUNNER_NO_CAPABLE_TIMEOUT_SECONDS`).
//
// | Variable                          | Meaning                                                                                |
// | --------------------------------- | -------------------------------------------------------------------------------------- |
// | RUNNER_DISPATCH_GIVE_UP_SECONDS   | Fail a job that waited this long for a claim (60 to 604800). Default 3600 when         |
// |                                   | RUNNER_DISPATCH=webhook, off when it polls. `0` turns it off.                          |
// | RUNNER_DISPATCH_MAX_RUNNING       | The pool cap the sweep keeps to (1 to 1000): it sends no more calls than there are    |
// |                                   | free slots. Unset: no cap on this side (the Dispatcher's own cap still holds).         |
import type { SweepSettings } from "./sweep.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_GIVE_UP_SECONDS = 3600;
export const GIVE_UP_SECONDS_RANGE = { min: 60, max: 7 * 24 * 3600 } as const;
export const MAX_RUNNING_RANGE = { min: 1, max: 1000 } as const;

function integer(env: Env, name: string): number | undefined {
  const text = env[name]?.trim();
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  return Number(text);
}

export function loadSweepSettings(env: Env): SweepSettings {
  const webhook = env.RUNNER_DISPATCH?.trim().toLowerCase() === "webhook";

  const seconds = integer(env, "RUNNER_DISPATCH_GIVE_UP_SECONDS");
  let giveUpSeconds: number | null = webhook ? DEFAULT_GIVE_UP_SECONDS : null;
  if (seconds === 0) giveUpSeconds = null;
  else if (
    seconds !== undefined &&
    seconds >= GIVE_UP_SECONDS_RANGE.min &&
    seconds <= GIVE_UP_SECONDS_RANGE.max
  )
    giveUpSeconds = seconds;

  const cap = integer(env, "RUNNER_DISPATCH_MAX_RUNNING");
  const maxRunning =
    cap !== undefined &&
    cap >= MAX_RUNNING_RANGE.min &&
    cap <= MAX_RUNNING_RANGE.max
      ? cap
      : null;

  return {
    giveUpMs: giveUpSeconds === null ? null : giveUpSeconds * 1000,
    maxRunning,
  };
}
