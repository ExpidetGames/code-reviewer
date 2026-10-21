// SPDX-License-Identifier: Apache-2.0

// Billable minutes (ADR 0006, 2.11; #493): the pure rules. A run's minutes are whole started minutes of the life of its
// VM, from the moment the Dispatcher created it to its teardown, with no minimum charge beyond "a VM that exists costs
// one minute". The price (#494, pricing.ts) takes the integer this module makes; nothing here knows a rate or a journal.
// See README.md, "Billable minutes".
import "server-only";

/**
 * How an end was learned. `app_stop_confirmed`: the answer of the Dispatcher to the App's stop call named the VM (the
 * App's own clock). `timeout_backstop`: nobody confirmed a teardown, so the end is the bounded guess of `backstopEnd`.
 * `job_wall_clock`: no VM exists (a self-hosted runner, Compose); the measure is the job's time on a runner.
 * `app_stop_unreported` (#498): the answer to the stop call named a VM nobody had reported (the report was lost, or the
 * Dispatcher is of an earlier release); the row is made then, from the claim to the stop. `claim_wall_clock` (#498): a hosted
 * job that ran has no VM row at all; its claim to its end is the measure, flagged so an audit sees that a VM was not measured.
 */
export const VM_END_SOURCES = [
  "app_stop_confirmed",
  "timeout_backstop",
  "job_wall_clock",
  "app_stop_unreported",
  "claim_wall_clock",
] as const;
export type VmEndSource = (typeof VM_END_SOURCES)[number];

/**
 * How long after the end of a job its VM may still be running when the App's stop call is on its way: the App's retries
 * take 25 seconds at most (`STOP_RETRY_DELAYS_MS`, `STOP_TIMEOUT_MS`) and the Dispatcher stops the VM in the background,
 * which takes 20 seconds or more. A VM that is still up after this window is up because our stop did not work, and that
 * is our error, not the customer's.
 */
export const STOP_RETRY_WINDOW_SECONDS = 60;

const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;

/**
 * `ceil(seconds / 60)`, at least 1 once a VM exists, 0 when none ever started (`startedAt` null: an error before the
 * launch). An end before the start (clocks of two machines) counts as zero seconds, so a VM that exists still bills one.
 */
export function billableMinutes(input: {
  startedAt: Date | null;
  endedAt: Date;
}): number {
  if (input.startedAt === null) return 0;
  const seconds = Math.max(
    0,
    (input.endedAt.getTime() - input.startedAt.getTime()) / SECOND_MS,
  );
  return Math.max(1, Math.ceil(seconds / MINUTE_SECONDS));
}

/**
 * The end of a VM whose teardown nobody confirmed: the job's end plus the stop-retry window (the failure to stop is
 * ours, so what happened after that is not billed), never later than the VM's own timeout (the platform ends it there)
 * and never before the start. A job that ended before its VM was reported (a cancel during the launch) counts from the
 * start.
 */
export function backstopEnd(input: {
  startedAt: Date;
  timeoutSeconds: number;
  jobEndedAt: Date;
}): Date {
  const anchor = Math.max(
    input.jobEndedAt.getTime(),
    input.startedAt.getTime(),
  );
  const guess = anchor + STOP_RETRY_WINDOW_SECONDS * SECOND_MS;
  return new Date(
    Math.min(
      guess,
      input.startedAt.getTime() + input.timeoutSeconds * SECOND_MS,
    ),
  );
}

/** A moment taken as the end, kept between the start and the end of the VM's own timeout. */
export function boundedEnd(input: {
  startedAt: Date;
  timeoutSeconds: number;
  at: Date;
}): Date {
  const earliest = input.startedAt.getTime();
  const latest = earliest + input.timeoutSeconds * SECOND_MS;
  return new Date(Math.min(latest, Math.max(earliest, input.at.getTime())));
}
