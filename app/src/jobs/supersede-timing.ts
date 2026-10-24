// SPDX-License-Identifier: LicenseRef-Proprietary

// How long the claim of a run that a newer push superseded lasts, and why (#397). One place, and the contract file
// (`SupersedeTiming` in contracts/runner-api.v1.json) states the same numbers for the Worker side (#399), which a test
// on each side compares with its own constants.
//
// The Worker learns of the push at its next heartbeat, then finishes the model requests in flight and reports:
//
//     push --(heartbeat interval, at most 60 s)--> told --(drain, at most 120 s)--> report
//
// A model request may start up to the moment the process is told, and takes at most the longest request (PR-Agent's
// `ai_timeout` and the model proxy's timeout, 120 s). So the claim has to outlast 60 + 120 seconds, with a margin for
// the report's own retries. The Worker's host ends its process `KILL_MARGIN_SECONDS` before the end of the claim, which
// it reads from the `leaseExpiresAt` of the heartbeat answer (the app sets it once, at the push, to the end of the
// claim, and heartbeats do not extend it), so the report always arrives while the claim holds. A report that is a little
// later than the claim is still taken for a grace (the sweep does not settle the record before), so the exact cost of
// a Worker that used its whole drain is not lost to the moment at which some claim happens to expire leases.

/** The longest heartbeat interval a Worker uses (`MAX_HEARTBEAT_INTERVAL_SECONDS` of the Worker API client). */
export const MAX_WORKER_HEARTBEAT_INTERVAL_SECONDS = 60;
/** The longest model request: PR-Agent's `ai_timeout` and the timeout of the Worker's model proxy (#399). */
export const LONGEST_MODEL_REQUEST_SECONDS = 120;
/** How long the Worker lets a run drain after it was told (`SUPERSEDED_DRAIN_SECONDS` of the job host, #399). */
export const WORKER_DRAIN_SECONDS = LONGEST_MODEL_REQUEST_SECONDS;
/** The Worker ends its process this long before the end of the claim, so the end and the report fit in it. */
export const KILL_MARGIN_SECONDS = 20;
/** For the retries of the report and the clocks of the two sides. */
const MARGIN_SECONDS = 60;

/** How long the claim of a superseded run lasts: heartbeats answer `superseded` and the report is taken. */
export const SUPERSEDED_DRAIN_MS =
  (MAX_WORKER_HEARTBEAT_INTERVAL_SECONDS +
    WORKER_DRAIN_SECONDS +
    MARGIN_SECONDS) *
  1000;

/**
 * A report is taken this long after the claim ran out, and the sweep waits as long before it settles the record
 * with an unknown cost. After it, a report is refused (`409`, like a heartbeat) and its cost is not applied: a
 * record is settled once, and a reader of the usage feed may have it by then.
 */
export const SUPERSEDED_REPORT_GRACE_MS = 60_000;
