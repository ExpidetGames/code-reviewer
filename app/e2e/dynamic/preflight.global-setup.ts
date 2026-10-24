// SPDX-License-Identifier: LicenseRef-Proprietary

// The first thing the privileged Dynamic e2e lane does inside Playwright (#253): the preflight. Whatever the
// lane needs and does not have is named and the run stops, so nothing below ever skips or half runs. The
// wrapper (runner/scripts/run_dynamic_e2e.sh) runs the same check as a command before it starts Playwright;
// this one covers a run of the configuration by hand.
import {
  checkLane,
  collectFacts,
  describeMissing,
} from "../helpers/dynamic-preflight";

export default function globalSetup(): void {
  const missing = checkLane(collectFacts({}));
  if (missing.length > 0) throw new Error(describeMissing(missing));
}
