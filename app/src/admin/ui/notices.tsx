// SPDX-License-Identifier: Apache-2.0

// The notices of the portal. Worded here once, shown on the overview and next to the setting. The
// warning of a rule that cannot work yet comes from the shared rule copy (#169), so the wizard and
// the portal say the same thing.

import { FAIL_CLOSED_WARNING } from "../../signup/ui/rule-copy.ts";

/** The sign-up rule names emails or domains and nothing can verify an address yet (ADR section 2.5). */
export function FailClosedNotice() {
  return (
    <p role="note" className="alert alert-warning">
      <strong>This sign-up rule does not work yet.</strong>{" "}
      {FAIL_CLOSED_WARNING} Configure it under Mail or Setup. No invitation can
      be created either. Accounts that exist are not affected.
    </p>
  );
}
