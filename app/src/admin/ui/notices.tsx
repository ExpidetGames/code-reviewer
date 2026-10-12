// SPDX-License-Identifier: Apache-2.0

// The notices of the portal. The warning of a rule that cannot work yet comes from the shared rule
// copy (#169), so the wizard and the portal say the same thing. The overview shows it as a
// "Needs attention" row with links into Mail and Setup (#180); the setup page shows the full notice
// next to the setting (#181).

import Link from "next/link";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import type { AttentionNotice } from "../../components/needs-attention.tsx";
import { FAIL_CLOSED_WARNING } from "../../signup/ui/rule-copy.ts";

export const FAIL_CLOSED_TITLE = "This sign-up rule does not work yet.";
const FAIL_CLOSED_INVITATIONS =
  "No invitation can be created either. Accounts that exist are not affected.";

/** The sign-up rule names emails or domains and nothing can verify an address yet (ADR section 2.5). */
export function FailClosedNotice() {
  return (
    <p role="note" className="alert alert-warning">
      <strong>{FAIL_CLOSED_TITLE}</strong> {FAIL_CLOSED_WARNING} Configure it
      under Mail or Setup. {FAIL_CLOSED_INVITATIONS}
    </p>
  );
}

/** The same state as one row of the overview's "Needs attention" region (#180). */
export function failClosedAttention(): AttentionNotice {
  return {
    id: "sign-up-rule-fail-closed",
    severity: "warning",
    title: FAIL_CLOSED_TITLE,
    detail: (
      <>
        {FAIL_CLOSED_WARNING} Configure it under{" "}
        <Link href="/admin/mail">Mail</Link> or{" "}
        <Link href="/admin/setup">Setup</Link>.{" "}
        <HelpDisclosure label="What this means">
          {FAIL_CLOSED_INVITATIONS}
        </HelpDisclosure>
      </>
    ),
  };
}
