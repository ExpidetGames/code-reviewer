// SPDX-License-Identifier: Apache-2.0

// Which answers of the webhook route are a reason for the repair work of the requests that touch the database (#395:
// release the leases that ran out, send what is due). A delivery the app does not use, a duplicate, one that was
// ignored or skipped made no database call that is worth a wake-up of a scale-to-zero database, and a replay of a
// signed body (it answers `duplicate`) must not be a way to start work.
import type { WebhookAcceptedOutcome } from "./errors.ts";

/** The outcomes of a delivery that put a job in the queue, dropped waiting ones or changed an installation. */
export const TOUCHING_OUTCOMES: readonly WebhookAcceptedOutcome[] = [
  "trigger_enqueued",
  "waiting_jobs_discarded",
  "installation_changed",
];

/** True for a `202` whose outcome is one of `TOUCHING_OUTCOMES`. Reads a copy: the response is left as it is. */
export async function deliveryTouchedTheQueue(
  response: Response,
): Promise<boolean> {
  if (response.status !== 202) return false;
  try {
    const body = (await response.clone().json()) as { outcome?: unknown };
    return TOUCHING_OUTCOMES.some((outcome) => outcome === body.outcome);
  } catch {
    return false;
  }
}
