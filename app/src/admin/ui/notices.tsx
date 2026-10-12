// SPDX-License-Identifier: Apache-2.0

// The notices of the portal. Worded here once, shown on the overview and next to the setting.

/** The sign-up rule names emails or domains and nothing can verify an address yet (ADR section 2.5). */
export function FailClosedNotice() {
  return (
    <p role="note" className="alert alert-warning">
      <strong>This sign-up rule does not work yet.</strong> Rules that name
      emails or domains need verified addresses, and nothing can verify them
      right now. Until then nobody except you can sign up, and no invitation can
      be created. Configure a mail server (Mail) or make GitHub the only way to
      sign in (Setup) and the rule starts working. Accounts that exist are not
      affected.
    </p>
  );
}
